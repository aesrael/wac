#!/usr/bin/env node
import { format } from "node:util"
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, existsSync, openSync } from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import { join, normalize, resolve, dirname, basename } from "node:path"
import { authPath, configPath, defaultConfig, ensureDataDir, loadConfig, writeConfig } from "./config.js"
import type { WacConfig } from "./config.js"
import { WhatsAppClient, hasCredentials, type MessageEvent } from "./baileys.js"
import { OpencodeClientFacade, reachable } from "./serve-client.js"
import { SessionRouter } from "./sessions.js"
import { Store } from "./store.js"
import { chunk, softFormat, withSuffix } from "./chunker.js"
import { partsEmpty } from "./serve-client.js"
import { handleCommand, isLocalCommand, handlePassthrough } from "./commands.js"

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

async function sendChunked(
  whatsapp: WhatsAppClient,
  chatJid: string,
  text: string,
  label?: string,
): Promise<number> {
  const cleaned = softFormat(text)
  const parts = withSuffix(chunk(cleaned))
  if (parts.length === 0) return 0
  let failed = 0
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
// In-flight prompt controllers per chat: /stop aborts the live fetch so the
// queue frees immediately instead of waiting out the full prompt timeout.
const promptControllers = new Map<string, AbortController>()
// Chats the user cancelled: the aborted task's error reply becomes "cancelled".
const userCancelled = new Set<string>()

function cancelInFlightPrompt(chatJid: string): boolean {
  const ctl = promptControllers.get(chatJid)
  if (!ctl) return false
  userCancelled.add(chatJid)
  try {
    ctl.abort()
  } catch { /* best effort */ }
  return true
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
// - standalone (default): spawn a detached successor carrying our PID,
//   reply, exit. The successor polls our death, then takes over.
// - supervised (WAC_SUPERVISED=1, set by the launchd plist / systemd
//   unit): reply, mark the restart, exit nonzero so the supervisor
//   relaunches us. Nothing is ever spawned past the supervisor.

let restartArmed = false

/** True when running under a supervisor that restarts us on nonzero exit. */
function supervised(): boolean {
  return process.env.WAC_SUPERVISED === "1"
}

/** Nonzero exit asks a supervisor (launchd KeepAlive, systemd on-failure) to relaunch. */
const RESTART_EXIT_CODE = 2

function projectRoot(): string {
  const script = process.argv[1] ?? ""
  if (script) {
    const dir = dirname(resolve(script))
    // node dist/index.js serve → <root>/dist ; <root>/bin/* → <root>
    if (basename(dir) === "dist" || basename(dir) === "bin") return resolve(dir, "..")
    // node wac serve → <root>/wac (the wrapper lives in the root itself)
    if (basename(script) === "wac") return dir
    if (existsSync(join(dir, "package.json"))) return dir
  }
  return process.cwd()
}

function tscEntry(): string | undefined {
  // launchd runs with a skeletal PATH (no npx), so never rely on PATH
  // lookup: run the bundled compiler with this same node binary.
  const cands = [
    join(projectRoot(), "node_modules", "typescript", "bin", "tsc"),
    join(projectRoot(), "node_modules", "typescript", "lib", "tsc.js"),
  ]
  for (const c of cands) {
    try {
      if (existsSync(c)) return c
    } catch { /* ignore */ }
  }
  return undefined
}

function runTscGate(): { ok: boolean; error?: string } {
  const entry = tscEntry()
  if (!entry) return { ok: false, error: "typescript compiler not found under node_modules — run npm install" }
  try {
    execFileSync(process.execPath, [entry], { cwd: projectRoot(), timeout: 120_000, stdio: "pipe" })
    return { ok: true }
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const detail = (err.stderr?.toString() ?? err.stdout?.toString() ?? err.message ?? "tsc failed").trim().split("\n").slice(0, 5).join("\n")
    return { ok: false, error: detail }
  }
}

function successorScript(): string {
  const root = projectRoot()
  const dist = join(root, "dist", "index.js")
  if (existsSync(dist)) return dist
  return process.argv[1] ?? dist
}

function successorLog(dataDir: string, name: string): number | "ignore" {
  try {
    const dir = join(dataDir, "logs")
    mkdirSync(dir, { recursive: true })
    return openSync(join(dir, name), "a")
  } catch {
    return "ignore"
  }
}

function spawnSuccessor(oldPid: number, dataDir: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, WAC_TAKEOVER_FROM: String(oldPid) }
  // WAC_WELCOME is strictly opt-out: never inherit a suppression from an
  // ancestor generation — every handover announces itself.
  delete env.WAC_WELCOME
  // Successor logs to the same files so handovers stay observable.
  const stdio: ["ignore", number | "ignore", number | "ignore"] = [
    "ignore",
    successorLog(dataDir, "wac.log"),
    successorLog(dataDir, "wac.err.log"),
  ]
  const child = spawn(process.execPath, [successorScript(), "serve", "--takeover-from", String(oldPid)], {
    cwd: projectRoot(),
    detached: true,
    stdio,
    env,
  })
  child.unref()
}

/** Poll until oldPid is gone (or clearly not wac/node after PID reuse). True = dead, false = still stuck. */
async function waitForOldDeath(oldPid: number, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(oldPid)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return !isPidAlive(oldPid)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false // ESRCH: gone
  }
  // PID reuse guard: only treat node/wac as "still the old daemon".
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 3000 }).trim()
    if (!out) return false
    return out.includes("node") || out.includes("wac")
  } catch {
    return true // ps failed: assume alive, keep waiting
  }
}

/**
 * tsc gate → arm the handover. Supervised: nothing to spawn, the exit
 * below is the whole request. Standalone: spawn a detached successor.
 * Returns error text on failure, otherwise the mode for the exit step.
 */
function attemptRestart(dataDir: string): { error?: string; supervised?: boolean } {
  if (restartArmed) return { supervised: supervised() } // duplicate tap while exiting
  const gate = runTscGate()
  if (!gate.ok) return { error: `(error) not restarting — build fails:\n${gate.error}` }
  if (supervised()) {
    restartArmed = true
    return { supervised: true }
  }
  try {
    spawnSuccessor(process.pid, dataDir)
  } catch (error) {
    return { error: `(error) not restarting — could not spawn successor (${(error as Error).message})` }
  }
  restartArmed = true
  return { supervised: false }
}

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

  await enqueue(chatJid, () => processMessage(whatsapp, opencode, router, config, store, event))
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
  const promptText = event.quoted ? `> ${event.quoted.split("\n").join("\n> ")}\n\n${text}` : text
  if (!text.trim() && !media && !event.quoted && event.mediaError) {
    const why = event.mediaError === "too-large" ? "Media was too large (>25MB) to download." : "Couldn't download that media."
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
    if (result.isEmpty || result.error) {
      await sendChunked(whatsapp, chatJid, `(error) ${result.error ?? "model returned nothing readable — wrong or unpaid model?"}`, wacLabel(record.sessionId, record.model ?? config.defaultModel))
      return
    }
    await sendChunked(whatsapp, chatJid, result.text || "(no text reply)", wacLabel(record.sessionId, record.model ?? config.defaultModel))
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
  const ctl = new AbortController()
  promptControllers.set(chatJid, ctl)
  try {
    return await promptWithTimeout(
      opencode.prompt(record.sessionId, text, effectiveModel, system, media, ctl.signal),
      () => ctl.abort(),
      config.promptTimeoutMs,
    )
  } finally {
    if (promptControllers.get(chatJid) === ctl) promptControllers.delete(chatJid)
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
  created?: number
}

/**
 * Outbox queue: external tools (e.g. terminus schedule) drop
 * `{ to?, text, created? }` JSON files into `<dataDir>/outbox/`.
 * The daemon sends them through its own socket (no second Baileys
 * connection) and deletes on success. Stale files get an age prefix.
 */
function startOutbox(whatsapp: WhatsAppClient, config: WacConfig) {
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
        const to = msg.to ? toJid(msg.to) : toJid(config.allowlist[0])
        if (!allowed.has(to) || !(to.endsWith("@s.whatsapp.net") || to.endsWith("@lid"))) {
          throw new Error("outbox recipient is not allowlisted")
        }
        const failed = await sendChunked(whatsapp, to, body)
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

async function sendWelcome(whatsapp: WhatsAppClient, config: WacConfig): Promise<boolean> {
  const message = [
    `☘️ wac is online — send /help for commands, or just message me.`,
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

function pidPath(dataDir: string): string {
  return join(dataDir, "daemon.pid")
}

function acquireLock(dataDir: string): void {
  const path = pidPath(dataDir)
  try {
    const existing = readFileSync(path, "utf8").trim()
    if (existing) {
      const pid = Number(existing)
      if (Number.isFinite(pid) && pid !== process.pid) {
        try {
          process.kill(pid, 0) // signal 0: existence check only
          const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 3000 }).trim()
          if (out && (out.includes("node") || out.includes("wac"))) {
            console.error(`wac is already running (PID ${pid}) — exiting`)
            process.exit(0)
          }
        } catch {
          /* stale lock — fall through and overwrite */
        }
      }
    }
  } catch {
    /* no pid file yet */
  }
  writeFileSync(path, String(process.pid))
  // auto-release on exit — but only if the pidfile still holds OUR pid.
  // A detached /restart successor rewrites this file after we die; an
  // unconditional unlink here would delete the successor's lock.
  const ownPid = process.pid
  process.on("exit", () => {
    try {
      if (readFileSync(path, "utf8").trim() === String(ownPid)) unlinkSync(path)
    } catch { /* best effort */ }
  })
}

async function cmdServe(takeoverFrom?: number) {
  const config = ensureConfig()
  if (takeoverFrom && Number.isFinite(takeoverFrom) && takeoverFrom !== process.pid) {
    console.log(`takeover: waiting for old PID ${takeoverFrom} to exit…`)
    const dead = await waitForOldDeath(takeoverFrom)
    if (!dead) {
      // Old stuck — stand down, bridge stays up on the old process.
      console.error(`takeover: old PID ${takeoverFrom} still alive after ~10s — standing down`)
      process.exit(1)
    }
    console.log(`takeover: old PID ${takeoverFrom} gone — taking over`)
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
  startOutbox(whatsapp, config)

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
