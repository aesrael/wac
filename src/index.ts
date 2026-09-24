#!/usr/bin/env node
import { format } from "node:util"
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, existsSync, openSync } from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import { join, normalize, resolve, dirname, basename } from "node:path"
import { authPath, configPath, defaultConfig, ensureDataDir, loadConfig, writeConfig } from "./config.js"
import type { WacConfig } from "./config.js"
import { WhatsAppClient, hasCredentials, type MessageEvent } from "./baileys.js"
import { OpencodeClientFacade, reachable, serverVersion } from "./serve-client.js"
import { SessionRouter } from "./sessions.js"
import { Store } from "./store.js"
import { chunk, softFormat, withSuffix } from "./chunker.js"
import { partsEmpty, isInstantEmpty } from "./serve-client.js"
import { handleCommand, isLocalCommand, handlePassthrough } from "./commands.js"
import { supervised, RESTART_EXIT_CODE, attemptRestart, acquireLock, siblingServePids, killStalePid, waitForOldDeath } from "./supervise.js"

const BIN = "wac"

function usage() {
  console.log(`${BIN} <command>`)
  console.log()
  console.log("  serve        start the daemon (listen on WhatsApp)")
  console.log("  qr           display pairing QR and exit once linked")
  console.log("  status       connection + session summary")
  console.log("  help         this help")
  process.exit(0)
}

function fatal(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

function ensureConfig(): WacConfig {
  try {
    const config = loadConfig()
    ensureDataDir(config)
    return config
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const dataDir = defaultConfig().dataDir
    ensureDataDir(defaultConfig())
    writeConfig(defaultConfig())
    console.error(`No config found. Created a default config at ${configPath(dataDir)}.`)
    console.error(`Edit it to set "allowlist" (your WhatsApp number) and the opencode password.`)
    process.exit(1)
  }
}

// Outbound media: the agent can embed `[image:/abs/path.png optional caption]`
// anywhere in a reply — each marker is sent as a real WhatsApp image and removed
// from the text before chunking.
const IMAGE_RE = /\[image:(\S+)(?:\s+([^\]]*))?\]/g
function extractImages(text: string): { body: string; images: { path: string; caption: string }[] } {
  const images: { path: string; caption: string }[] = []
  const body = text.replace(IMAGE_RE, (marker: string, path: string, caption?: string) => {
    if (!existsSync(path)) return `(image not found: ${path})`
    images.push({ path, caption: (caption ?? "").trim() })
    return ""
  })
  return { body, images }
}

// Outbound documents: `[file:/abs/path.pdf optional caption]` — sent as a real
// WhatsApp document. Same contract as images, separate marker so old prompts keep working.
const FILE_RE = /\[file:(\S+)(?:\s+([^\]]*))?\]/g
function extractFiles(text: string): { body: string; files: { path: string; caption: string }[] } {
  const files: { path: string; caption: string }[] = []
  const body = text.replace(FILE_RE, (marker: string, path: string, caption?: string) => {
    if (!existsSync(path)) return `(file not found: ${path})`
    files.push({ path, caption: (caption ?? "").trim() })
    return ""
  })
  return { body, files }
}

async function sendChunked(
  whatsapp: WhatsAppClient,
  chatJid: string,
  text: string,
  label?: string,
): Promise<number> {
  const { body: afterImages, images } = extractImages(softFormat(text))
  const { body: cleaned, files } = extractFiles(afterImages)
  let failed = 0
  for (const image of images) {
    try {
      await whatsapp.sendImage(chatJid, image.path, image.caption)
    } catch (error) {
      failed++
      console.error(`failed to send image ${image.path} to ${chatJid}: ${format(error)}`)
    }
  }
  for (const file of files) {
    try {
      await whatsapp.sendDocument(chatJid, file.path, file.caption)
    } catch (error) {
      failed++
      console.error(`failed to send file ${file.path} to ${chatJid}: ${format(error)}`)
    }
  }
  const parts = withSuffix(chunk(cleaned))
  for (let i = 0; i < parts.length; i++) {
    const body = i === 0 && label ? `${label}\n\n${parts[i]}` : i === 0 ? `◆ wac\n\n${parts[i]}` : parts[i]
    try {
      await whatsapp.sendText(chatJid, body)
    } catch (error) {
      failed++
      console.error(`failed to send chunk ${i + 1}/${parts.length} to ${chatJid}: ${format(error)}`)
    }
  }
  if (failed > 0) console.error(`sendChunked to ${chatJid}: ${failed}/${parts.length} chunks failed — caller sees it as undelivered`)
  return failed
}

function wacLabel(sessionId?: string, model?: string): string {
  const short = sessionId ? sessionId.slice(0, 8) : ""
  const parts: string[] = []
  if (short) parts.push(`_${short}_`)
  if (model) parts.push(`_${model}_`)
  const line = parts.length === 0 ? "◆ wac · *no active session*" : `◆ wac · ${parts.join(" · ")}`
  return `> ${line}`
}

const chatQueues = new Map<string, Promise<void>>()
// /wait pipe: plain prompts send straight through (see handleIncoming) and
// this chain is now opt-in per message, preserving one-reply-per-message.
// In-flight prompt controllers per chat: /stop aborts every live fetch so
// overlapping send-through runs all die instead of waiting out timeouts.
const promptControllers = new Map<string, Set<AbortController>>()
// Chats the user cancelled: the aborted task's error reply becomes "cancelled".
const userCancelled = new Set<string>()

function trackController(chatJid: string, ctl: AbortController): void {
  let set = promptControllers.get(chatJid)
  if (!set) {
    set = new Set()
    promptControllers.set(chatJid, set)
  }
  set.add(ctl)
}

function untrackController(chatJid: string, ctl: AbortController): void {
  const set = promptControllers.get(chatJid)
  if (!set) return
  set.delete(ctl)
  if (set.size === 0) promptControllers.delete(chatJid)
}

function cancelInFlightPrompt(chatJid: string): boolean {
  const set = promptControllers.get(chatJid)
  if (!set || set.size === 0) return false
  userCancelled.add(chatJid)
  for (const ctl of set) {
    try {
      ctl.abort()
    } catch { /* best effort */ }
  }
  return true
}

// In-flight send-through runs per chat: /wait drains a snapshot of these
// before running, so it truly waits for the live reply. (The /wait
// enqueue chain alone can't do this — send-through bypasses that chain,
// so without this /wait would fire immediately.)
const inflightRuns = new Map<string, Set<Promise<void>>>()

function trackRun(chatJid: string): () => void {
  let set = inflightRuns.get(chatJid)
  if (!set) {
    set = new Set()
    inflightRuns.set(chatJid, set)
  }
  let release!: () => void
  const p = new Promise<void>((resolve) => { release = resolve })
  set.add(p)
  return () => {
    set!.delete(p)
    release()
    if (set!.size === 0) inflightRuns.delete(chatJid)
  }
}

async function drainRuns(chatJid: string): Promise<void> {
  const snapshot = [...(inflightRuns.get(chatJid) ?? [])]
  if (snapshot.length === 0) return
  await Promise.allSettled(snapshot)
}

// Delivered opencode message ids per chat (cap ~50): overlapping
// send-through waits can resolve on the same covering turn, and each would
// otherwise send that same reply to WhatsApp. First sender wins.
const deliveredIds = new Map<string, Set<string>>()
const MAX_DELIVERED = 50
// Per-chat send chain: concurrent replies can't interleave chunks.
const sendChains = new Map<string, Promise<void>>()

function alreadyDelivered(chatJid: string, id: string): boolean {
  let set = deliveredIds.get(chatJid)
  if (!set) {
    set = new Set()
    deliveredIds.set(chatJid, set)
  }
  if (set.has(id)) return true
  set.add(id)
  while (set.size > MAX_DELIVERED) {
    const oldest = set.values().next()
    if (oldest.done) break
    set.delete(oldest.value)
  }
  return false
}

// Send a prompt reply exactly once per opencode message id. Replies without
// an id (local errors) send directly via sendChunked as before.
async function sendReplyOnce(
  whatsapp: WhatsAppClient,
  chatJid: string,
  messageId: string | undefined,
  text: string,
  label?: string,
): Promise<number> {
  if (messageId && alreadyDelivered(chatJid, messageId)) return 0
  const prev = sendChains.get(chatJid) ?? Promise.resolve()
  const next = prev.then(() => sendChunked(whatsapp, chatJid, text, label))
  sendChains.set(chatJid, next.catch(() => undefined).then(() => undefined))
  return next
}

function isCancelError(error: unknown): boolean {
  if (error instanceof PromptTimeoutError) return false
  const name = (error as { name?: string })?.name ?? ""
  const msg = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error ? String((error as { cause?: unknown }).cause ?? "") : ""
  return name === "AbortError" || /abort|cancel/i.test(`${msg} ${cause}`.slice(0, 200))
}
class PromptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`opencode prompt timed out after ${Math.round(timeoutMs / 1000)} seconds`)
    this.name = "PromptTimeoutError"
  }
}

async function promptWithTimeout<T>(work: Promise<T>, abort: () => void, timeoutMs: number): Promise<T> {
  // One timer does both: aborts the underlying fetch (socket dies for real)
  // and rejects the race. Handlers attach up front, so the late settler
  // can never surface as an unhandled rejection and take the daemon down.
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        abort()
      } catch { /* best effort */ }
      reject(new PromptTimeoutError(timeoutMs))
    }, timeoutMs)
    work.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function enqueue<T>(chatJid: string, fn: () => Promise<T>): Promise<T> {
  const prev = chatQueues.get(chatJid) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chatQueues.set(chatJid, next.catch(() => undefined).then(() => undefined))
  return next
}

// --- /restart: graceful handover, deployment-agnostic ---
//
// Two modes, same code on every OS. The deployment declares itself —
// wac never names a supervisor:
// Restart/supervision mechanics live in ./supervise.js (keeps this file about messaging).

function scheduleRestartExit(whatsapp: WhatsAppClient, store: Store, config: WacConfig, exitCode: number) {
  // Reply is flushed by the caller first; give Baileys ~500ms to send,
  // then disconnect WA (opencode serve stays up, untouched) and exit.
  // Standalone: the successor polls our death, then takes over the
  // pidfile + socket (new socket kicks the old one — safe direction).
  // Supervised: the nonzero exit is the relaunch request.
  setTimeout(() => {
    try {
      store.flush()
    } catch { /* best effort */ }
    void whatsapp.shutdown()
    console.log(`restarting wac (exit ${exitCode})`)
    // Do not wait for Baileys' close event. It can be delayed or never arrive
    // on a half-dead socket; the supervisor must receive the exit code.
    process.exit(exitCode)
  }, 500)
}

async function handleIncoming(
  whatsapp: WhatsAppClient,
  opencode: OpencodeClientFacade,
  router: SessionRouter,
  config: WacConfig,
  store: Store,
  event: MessageEvent,
) {
  const { chatJid, senderJid, text, isGroup, fromMe } = event

  if (fromMe && !(await whatsapp.isSelfChat(chatJid))) {
    return // outbound to another chat (incl. Meta AI rooms): never process
  }
  if (isGroup) {
    return
  }
  if (chatJid.endsWith("@broadcast") || chatJid.endsWith("@newsletter")) {
    return // stories/broadcast lists/channels: never process
  }
  const effectiveSender = fromMe ? chatJid : senderJid
  if (!(await whatsapp.isAllowed(effectiveSender))) {
    return // non-allowlisted: silent drop, never enqueued
  }
  // Ack as read once accepted: blue ticks for the sender, clears the
  // linked-device unread. Best effort, never blocks the reply.
  await whatsapp.markRead(chatJid, event.messageId, fromMe)

  // Local commands jump the queue: the agent keeps working in the
  // background, but /status /restart etc answer immediately and never
  // wait on a long prompt. Failures reply as (error) text here.
  const trimmed = text.trim()
  if (trimmed && isLocalCommand(trimmed)) {
    try {
      const result = await handleCommand(router, opencode, config, chatJid, trimmed, { onStop: cancelInFlightPrompt })
      if (result.handled) {
        if (result.restart) {
          const { error, supervised: sup } = attemptRestart(config.dataDir)
          const s = router.chatSession(chatJid)
          const label = wacLabel(s?.sessionId, s?.model ?? config.defaultModel)
          await sendChunked(whatsapp, chatJid, error ?? result.text, label)
          if (!error) scheduleRestartExit(whatsapp, store, config, sup ? RESTART_EXIT_CODE : 0)
          return
        }
        const s = router.chatSession(chatJid)
        await sendChunked(whatsapp, chatJid, result.text, wacLabel(s?.sessionId, s?.model ?? config.defaultModel))
      }
    } catch (error) {
      const s = router.chatSession(chatJid)
      await sendChunked(whatsapp, chatJid, `(error) ${(error as Error).message}`, wacLabel(s?.sessionId, s?.model ?? config.defaultModel))
    }
    return
  }

  // /wait <text> (alias /w): opt into the old serial pipe — drains
  // then runs, one reply per message. Plain text sends straight through
  // instead: opencode's inbox merges it and overlapping waits dedupe on
  // delivery (see sendReplyOnce).
  const waitMatch = trimmed.match(/^\/w(?:ait)?(?:\s+(.*))?$/s)
  if (waitMatch) {
    const rest = (waitMatch[1] ?? "").trim()
    if (!rest) {
      const s = router.chatSession(chatJid)
      await sendChunked(whatsapp, chatJid, "Usage: /wait <message> — queue this behind the running reply.", wacLabel(s?.sessionId, s?.model ?? config.defaultModel))
      return
    }
    await enqueue(chatJid, async () => {
      await drainRuns(chatJid)
      await processMessage(whatsapp, opencode, router, config, store, { ...event, text: rest })
    })
    return
  }

  const done = trackRun(chatJid)
  void (async () => {
    try {
      await processMessage(whatsapp, opencode, router, config, store, event)
    } catch (error) {
      console.error(`send-through error: ${format(error)}`)
    } finally {
      done()
    }
  })()
}

function effectiveModelFor(router: SessionRouter, config: WacConfig, chatJid: string): string | undefined {
  return router.chatSession(chatJid)?.model ?? config.defaultModel
}

async function processMessage(
  whatsapp: WhatsAppClient,
  opencode: OpencodeClientFacade,
  router: SessionRouter,
  config: WacConfig,
  store: Store,
  event: MessageEvent,
) {
  const { chatJid, text, media } = event
  // quoted reply context rides along to the model, never into command parsing
  // inbound send-time rides as a short prefix so the model can anchor reminders and late delivery
  const when = event.sentAt
    ? new Date(event.sentAt * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : ""
  const promptText = (when ? `[${when}] ` : "") + (event.quoted ? `> ${event.quoted.split("\n").join("\n> ")}\n\n${text}` : text)
  if (!text.trim() && !media && !event.quoted && event.mediaError) {
    const why =
      event.mediaError === "too-large"
        ? "Media was too large (>25MB) to download."
        : event.mediaError === "unsupported"
          ? "I can't read that yet (location / contact / poll / reaction). Send text or a photo/video/doc/voice note."
          : "Couldn't download that media."
    const s = router.chatSession(chatJid)
    await sendChunked(whatsapp, chatJid, `(error) ${why} Try a smaller file or add a caption.`, wacLabel(s?.sessionId, s?.model ?? config.defaultModel))
    return
  }
  await whatsapp.startTyping(chatJid)
  try {
    if (text.trim() && isLocalCommand(text)) {
      const result = await handleCommand(router, opencode, config, chatJid, text, { onStop: cancelInFlightPrompt })
      if (result.handled) {
        if (result.restart) {
          const { error, supervised: sup } = attemptRestart(config.dataDir)
          const s = router.chatSession(chatJid)
          const label = wacLabel(s?.sessionId, s?.model ?? config.defaultModel)
          await sendChunked(whatsapp, chatJid, error ?? result.text, label)
          if (!error) scheduleRestartExit(whatsapp, store, config, sup ? RESTART_EXIT_CODE : 0)
          return
        }
        const s = router.chatSession(chatJid)
        await sendChunked(whatsapp, chatJid, result.text, wacLabel(s?.sessionId, s?.model ?? config.defaultModel))
      }
      return
    }

    const record = await router.resolve(chatJid)
    if (text.trim().startsWith("/")) {
      try {
        const reply = await handlePassthrough(opencode, record.sessionId, text)
        if (reply) await sendChunked(whatsapp, chatJid, reply, wacLabel(record.sessionId, record.model ?? config.defaultModel))
        return
      } catch (error) {
        await sendChunked(whatsapp, chatJid, `(error) ${(error as Error).message}`, wacLabel(record.sessionId, record.model ?? config.defaultModel))
        return
      }
    }

    const result = await promptWithRetry(opencode, router, chatJid, record, promptText, config, media)
    // Seed bookkeeping keys off inbox acceptance, not reply success: the seed
    // text is in history once the prompt POST lands, so a failed turn must
    // not re-send it next time (that loop is how wedged sessions got
    // system.prompt on every retry).
    if (result.seedEnqueued) router.markSystemSeeded(chatJid, record.sessionId)
    if (result.isEmpty || result.error) {
      // Always surface the backend's real reason: fast-failing turns used to
      // arrive with the generic text only, hiding rate limits and auth errors.
      const real = (result.error ?? "").replace(/^no assistant reply recorded[.\s:-]*/i, "").trim()
      const backendSaid = real ? ` Backend said: ${real.slice(0, 300)}` : ""
      const errText =
        isInstantEmpty(result.waitMs, result.error)
          ? `no reply recorded yet — the turn may still be running (slow session, or picked up by your terminal on this chat). Wait a minute and retry. If it keeps failing instantly for minutes, the session is stalled: /fork keeps history, /new starts clean.${backendSaid}`
          : (result.error ?? "model returned nothing readable — wrong or unpaid model?")
      await sendReplyOnce(whatsapp, chatJid, result.message?.id, `(error) ${errText}`, wacLabel(record.sessionId, record.model ?? config.defaultModel))
      return
    }
    await sendReplyOnce(whatsapp, chatJid, result.message?.id, result.text || "(no text reply)", wacLabel(record.sessionId, record.model ?? config.defaultModel))
  } catch (error) {
    console.error(`handler error: ${format(error)}`)
    const s = router.chatSession(chatJid)
    const label = wacLabel(s?.sessionId, s?.model ?? config.defaultModel)
    let msg: string
    if (userCancelled.has(chatJid) || isCancelError(error)) {
      userCancelled.delete(chatJid)
      msg = "cancelled — nothing left running. Send a message to continue, /restart if it stays stuck."
    } else if (error instanceof PromptTimeoutError) {
      // Fail-fast: abort server-side work so nothing is left running,
      // then terminate. Never retry — re-issuing duplicates side effects.
      // The abort has its own deadline; if it fails, say so honestly.
      let cancelled = true
      try {
        if (s?.sessionId) await opencode.abortSession(s.sessionId)
      } catch {
        cancelled = false
      }
      const secs = Math.round(config.promptTimeoutMs / 1000)
      msg = cancelled
        ? `timed out after ${secs}s, cancelled — nothing left running. Send /new for a fresh session or ask in smaller chunks.`
        : `timed out after ${secs}s, but the cancel may not have taken — send /stop once, or /new for a fresh session.`
    } else if (error instanceof Error) {
      msg = error.message
    } else {
      msg = String(error)
    }
    await sendChunked(whatsapp, chatJid, `(error) ${msg}`, label)
  } finally {
    await whatsapp.stopTyping(chatJid)
  }
}

async function promptWithRetry(
  opencode: OpencodeClientFacade,
  router: SessionRouter,
  chatJid: string,
  record: Awaited<ReturnType<SessionRouter["resolve"]>>,
  text: string,
  config: WacConfig,
  media?: { buffer: Buffer; mime: string; filename?: string },
) {
  const effectiveModel = record.model ?? config.defaultModel
  // No stamping: the record keeps explicit models only, so the global
  // default stays live for every prompt.
  // Single attempt, never retry a prompt: opencode may already have executed
  // tools server-side, so re-issuing duplicates side effects. On timeout the
  // fetch is aborted (socket dies for real) and the caller aborts the
  // session best-effort; the abort itself has a deadline and can't jam the queue.
  const mins = Math.max(1, Math.round(config.promptTimeoutMs / 60000))
  const system = `${config.systemPrompt} Reply window: approx ${mins} min. Prefer a complete, correct answer; only send a partial plus the next step if it genuinely won't fit.`
  // Send the system prompt once per session: the opencode session persists, so
  // folding ~300 words into every turn is pure spend. Fresh sessions (and the
  // first turn after /compact) get it; everything else rides the history.
  const seed = record.systemSeeded ? undefined : system
  const ctl = new AbortController()
  trackController(chatJid, ctl)
  try {
    const result = await promptWithTimeout(
      opencode.prompt(record.sessionId, text, effectiveModel, seed, media, ctl.signal),
      () => ctl.abort(),
      config.promptTimeoutMs,
    )
    // Seed marking lives with the caller (keys off inbox acceptance, not
    // reply success). Nothing to do here on success.
    return result
  } finally {
    untrackController(chatJid, ctl)
    // /stop can race a prompt that has already settled successfully; never
    // let that stale marker relabel a later, unrelated error as cancelled.
    userCancelled.delete(chatJid)
  }
}

function toJid(number: string): string {
  if (number.includes("@")) return number
  const digits = number.replace(/^\+/, "").replace(/[\s\-().]/g, "")
  return `${digits}@s.whatsapp.net`
}

const OUTBOX_POLL_MS = 15_000

type OutboxMessage = {
  to?: string
  text?: string
  image?: string
  file?: string
  created?: number
}

/**
 * Outbox queue: external tools (e.g. terminus schedule) drop
 * `{ to?, text, image?, file?, created? }` JSON files into `<dataDir>/outbox/`.
 * The daemon sends them through its own socket (no second Baileys
 * connection) and deletes on success. Stale files get an age prefix.
 */
function startOutbox(whatsapp: WhatsAppClient, config: WacConfig, router: SessionRouter) {
  const dir = join(config.dataDir, "outbox")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const failures = new Map<string, number>()
  let running = false
  const allowed = new Set(config.allowlist.map(toJid))
  const poll = async () => {
    if (running) return
    running = true
    try {
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    } catch {
      return
    }
    for (const file of files) {
      const path = join(dir, file)
      try {
        const msg = JSON.parse(readFileSync(path, "utf8")) as OutboxMessage
        if (!msg.text?.trim()) {
          unlinkSync(path)
          continue
        }
        const ageMin = msg.created ? (Date.now() - msg.created) / 60000 : 0
        const body =
          ageMin > 5
            ? `(queued ${new Date(msg.created as number).toLocaleString()})\n\n${msg.text}`
            : msg.text
        const imageTag = typeof msg.image === "string" && msg.image.trim() ? `\n[image:${msg.image.trim()}]` : ""
        const fileTag = typeof msg.file === "string" && msg.file.trim() ? `\n[file:${msg.file.trim()}]` : ""
        const payload = imageTag || fileTag ? `${msg.text.trim()}${imageTag}${fileTag}` : body
        const to = msg.to ? toJid(msg.to) : toJid(config.allowlist[0])
        if (!allowed.has(to) || !(to.endsWith("@s.whatsapp.net") || to.endsWith("@lid"))) {
          throw new Error("outbox recipient is not allowlisted")
        }
        // Read-only lookup: never remaps. Direct chat session only —
        // no first-chat fallback, so an unmapped recipient stays
        // session-less instead of wearing an unrelated chat's id.
        const s = router.chatSession(to)
        const failed = await sendChunked(whatsapp, to, payload,
          s ? wacLabel(s.sessionId, s.model ?? config.defaultModel) : wacLabel(undefined, config.defaultModel))
        if (failed > 0) throw new Error(`whatsapp send failed (${failed} chunks undelivered) — keeping for retry`)
        unlinkSync(path)
        failures.delete(file)
        console.log(`outbox sent ${file}`)
      } catch (error) {
        const n = (failures.get(file) ?? 0) + 1
        failures.set(file, n)
        console.error(`outbox failed ${file} (attempt ${n}): ${format(error)}`)
        if (n >= 5) {
          try {
            renameSync(path, `${path}.dead`)
          } catch {
            /* already gone */
          }
          failures.delete(file)
        }
      }
    }
    } finally { running = false }
  }
  setInterval(() => {
    void poll()
  }, OUTBOX_POLL_MS)
  void poll() // deliver immediately on boot, don't wait a full interval
}

function wacVersion(): string {
  const repo = dirname(dirname(resolve(process.argv[1])))
  try {
    const out = execFileSync("git", ["describe", "--tags", "--always"], { cwd: repo, timeout: 3000 }).toString().trim()
    if (out) return out
  } catch { /* fall through */ }
  try {
    return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version || "unknown"
  } catch { /* fall through */ }
  return "unknown"
}

function sdkVersion(): string {
  try {
    const pkg = resolve(dirname(resolve(process.argv[1])), "../node_modules/@opencode/client/package.json")
    return JSON.parse(readFileSync(pkg, "utf8")).version || "unknown"
  } catch { /* fall through */ }
  return "unknown"
}

function semverLt(a: string, b: string): boolean {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10) || 0)
  const pb = b.split(".").map((s) => Number.parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false
  }
  return false
}

async function sendWelcome(whatsapp: WhatsAppClient, config: WacConfig): Promise<boolean> {
  const auth = {
    baseUrl: config.opencodeBaseUrl,
    username: config.opencodeUsername,
    password: config.opencodePassword,
    directory: config.opencodeDirectory,
  }
  const [server, sdk] = await Promise.all([serverVersion(auth), Promise.resolve(sdkVersion())])
  const message = [
    `☘️ wac is online — send /help for commands, or just message me.`,
    ``,
    `_wac ${wacVersion()} · opencode ${server ?? "?"} (SDK ${sdk})_`,
    ...(server && semverLt(server, sdk)
      ? [``, `> ⚠ upgrade opencode to ${sdk} (\`opencode upgrade\`) for best experience`]
      : []),
  ].join("\n")
  let sent = 0
  for (const number of config.allowlist) {
    try {
      await whatsapp.sendText(toJid(number), message)
      console.log(`sent welcome to ${number}`)
      sent++
    } catch (error) {
      console.error(`failed to send welcome to ${number}: ${format(error)}`)
    }
  }
  return sent > 0
}

async function cmdServe(takeoverFrom?: number) {
  const config = ensureConfig()
  const entry = resolve(process.argv[1] ?? "")
  if (takeoverFrom && Number.isFinite(takeoverFrom) && takeoverFrom !== process.pid) {
    console.log(`takeover: waiting for old PID ${takeoverFrom} to exit…`)
    const dead = await waitForOldDeath(takeoverFrom)
    if (!dead) {
      // Old stuck (long prompt, wedged socket) — terminate it instead of
      // standing down, otherwise both generations hold the WA session.
      console.error(`takeover: old PID ${takeoverFrom} stuck — terminating`)
      const gone = await killStalePid(takeoverFrom, entry)
      if (!gone) {
        console.error(`takeover: old PID ${takeoverFrom} unkillable — standing down`)
        process.exit(1)
      }
      console.log(`takeover: old PID ${takeoverFrom} terminated — taking over`)
    } else {
      console.log(`takeover: old PID ${takeoverFrom} gone — taking over`)
    }
  }
  if (supervised()) {
    // launchd/systemd owns us: any other identical generation is a stray
    // (hand-started copy, survived handover). Cull before connecting so two
    // generations never fight over the WhatsApp session (code 440 loop).
    // Manual runs skip this — there WE are the likely stray.
    for (const pid of siblingServePids(process.pid, entry)) {
      console.log(`cull: stale wac generation PID ${pid} — terminating`)
      await killStalePid(pid, entry)
    }
  }
  // In supervised mode launchd/systemd owns process uniqueness. Avoid a
  // pidfile entirely: an exiting generation can otherwise race a replacement
  // and remove the replacement's pidfile. Standalone mode keeps the guard.
  if (!supervised()) acquireLock(config.dataDir)
  if (config.allowlist.length === 0) {
    fatal(`config "allowlist" is empty — add your WhatsApp number to ${configPath(config.dataDir)}`)
  }

  const store = new Store(config.dataDir)
  const opencode = new OpencodeClientFacade({
    baseUrl: config.opencodeBaseUrl,
    username: config.opencodeUsername,
    password: config.opencodePassword,
    directory: config.opencodeDirectory,
    requestTimeoutMs: config.promptTimeoutMs,
  })
  const router = new SessionRouter(opencode, store)
  const whatsapp = new WhatsAppClient(config, authPath(config.dataDir))
  let welcomeSent = false
  let welcomeTimer: ReturnType<typeof setTimeout> | undefined
  let shuttingDown = false
  const opencodeChildren = new Set<number>()

  whatsapp.statusListener = (status, qr) => {
    const line =
      status === "open"
        ? "WhatsApp: connected"
        : status === "qr"
          ? "WhatsApp: needs QR — scan with your phone"
          : `WhatsApp: ${status}`
    console.log(line)
    if (status === "close") {
      if (welcomeTimer) clearTimeout(welcomeTimer)
      welcomeTimer = undefined
    }
    if (status === "open" && !welcomeSent && !welcomeTimer && config.welcomeOnConnect !== false && process.env.WAC_WELCOME !== "0") {
      // Baileys reports `open` before the linked-device send path is fully
      // settled. Retry on failure, but never send twice after success.
      welcomeTimer = setTimeout(() => {
        welcomeTimer = undefined
        if (whatsapp.statusText !== "open") return
        void sendWelcome(whatsapp, config).then((ok) => {
          if (ok) {
            welcomeSent = true
          } else if (whatsapp.statusText === "open") {
            // A request can be accepted locally and still fail during sync.
            // Leave the flag unset so the next open/retry can try again.
            welcomeTimer = setTimeout(() => {
              welcomeTimer = undefined
              if (whatsapp.statusText === "open") void sendWelcome(whatsapp, config).then((sent) => { welcomeSent = sent })
            }, 5_000)
          }
        })
      }, 5_000)
    }
    void qr
  }

  whatsapp.messageListener = (event) => handleIncoming(whatsapp, opencode, router, config, store, event)
  startOutbox(whatsapp, config, router)

  const creds = await hasCredentials(authPath(config.dataDir))
  if (!creds) {
    console.log("No WhatsApp credentials yet — a QR will be shown. Scan it to link this device.")
  }

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log("shutting down…")
    await whatsapp.shutdown()
    store.flush()
    for (const pid of opencodeChildren) {
      try { process.kill(pid, "SIGTERM") } catch { /* best effort */ }
    }
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

  const opencodeUp = await opencode.check()
  if (!opencodeUp) {
    console.log(`warning: opencode serve not reachable at ${config.opencodeBaseUrl} — will retry`)
    const child = ensureOpenCodeServer(config)
    if (child && child.pid) opencodeChildren.add(child.pid)
  } else {
    console.log(`opencode serve: reachable at ${config.opencodeBaseUrl}`)
  }

  await whatsapp.start()
}

function ensureOpenCodeServer(config: WacConfig): import("node:child_process").ChildProcess | undefined {
  try {
    const url = new URL(config.opencodeBaseUrl)
    const port = url.port || "8080"
    const home = process.env.HOME ?? ""
    const rawBin = process.env.OPENCODE_BIN || (home ? `${home}/.opencode/bin/opencode` : "")
    if (!rawBin) throw new Error("no opencode binary path available")
    const bin = normalize(resolve(rawBin))
    const allowedPrefixes = [
      home ? normalize(resolve(home, ".opencode")) : "",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      normalize(resolve(process.cwd(), "node_modules/.bin")),
    ].filter(Boolean)
    const ok = allowedPrefixes.some((p) => bin === p || bin.startsWith(`${p}/`)) || bin.endsWith("/bin/opencode")
    if (!ok) throw new Error(`refusing to spawn opencode from untrusted OPENCODE_BIN=${rawBin}`)
    const env = { ...process.env }
    if (config.opencodePassword) env.OPENCODE_SERVER_PASSWORD = config.opencodePassword
    const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", port], {
      stdio: "ignore",
      detached: true,
      env,
    })
    child.unref()
    console.log(`spawned opencode serve on :${port}`)
    return child
  } catch (error) {
    console.error(`could not spawn opencode serve: ${format(error)}`)
    return undefined
  }
}

async function cmdQr() {
  const config = ensureConfig()
  console.log("Scan the QR below with WhatsApp > Linked devices.")
  const whatsapp = new WhatsAppClient(config, authPath(config.dataDir))
  const done = new Promise<void>((resolve) => {
    whatsapp.statusListener = (status) => {
      if (status === "open") resolve()
    }
  })
  await whatsapp.start()
  await done
  console.log("Linked. You can now run wac serve.")
  await whatsapp.shutdown()
  process.exit(0)
}

async function cmdStatus() {
  const config = ensureConfig()
  const creds = await hasCredentials(authPath(config.dataDir))

  let opencodeOk = false
  let opencodeLine = "opencode serve: unreachable"
  try {
    opencodeOk = await reachable({
      baseUrl: config.opencodeBaseUrl,
      username: config.opencodeUsername,
      password: config.opencodePassword,
      directory: config.opencodeDirectory,
    })
    opencodeLine = opencodeOk ? "opencode serve: reachable" : "opencode serve: down (retrying)"
  } catch {
    opencodeLine = "opencode serve: unreachable"
  }

  console.log(`WhatsApp: ${creds ? "credentials present" : "needs QR link"}`)
  console.log(opencodeLine)
  const store = new Store(config.dataDir)
  const mapping = store.all()
  console.log(`sessions: ${Object.keys(mapping).length} mapped`)
  for (const [chat, record] of Object.entries(mapping)) {
    console.log(`  ${chat}  ->  ${record.sessionId}${record.model ? `  (${record.model})` : ""}`)
  }
  if (!opencodeOk) process.exitCode = 1
}

// Safety net: a late-settling promise must never take the daemon down
// (and every queued message with it). Log and survive rejections;
// genuine crashes still exit via uncaught exceptions and launchd restarts.
process.on("unhandledRejection", (reason) => {
  console.error(`unhandled rejection (surviving): ${format(reason)}`)
})

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case "serve": {
      const flagIdx = rest.findIndex((a) => a === "--takeover-from")
      const fromFlag = flagIdx >= 0 ? Number(rest[flagIdx + 1]) : NaN
      const takeover = Number.isFinite(fromFlag) ? fromFlag : Number(process.env.WAC_TAKEOVER_FROM)
      return cmdServe(Number.isFinite(takeover) ? takeover : undefined)
    }
    case "qr":
      return cmdQr()
    case "status":
      return cmdStatus()
    case "help":
    case undefined:
      usage()
    default:
      fatal(`unknown command: ${command}`)
  }
}

main().catch((error) => {
  console.error(format(error))
  process.exit(1)
})
