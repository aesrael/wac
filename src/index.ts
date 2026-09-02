#!/usr/bin/env node
import { format } from "node:util"
import { authPath, configPath, defaultConfig, ensureDataDir, loadConfig, writeConfig } from "./config.js"
import type { WacConfig } from "./config.js"
import { WhatsAppClient, hasCredentials, type MessageEvent } from "./baileys.js"
import { OpencodeClientFacade, reachable } from "./serve-client.js"
import { SessionRouter } from "./sessions.js"
import { Store } from "./store.js"
import { chunk, softFormat, withSuffix } from "./chunker.js"
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
) {
  const cleaned = softFormat(text)
  const parts = withSuffix(chunk(cleaned))
  for (let i = 0; i < parts.length; i++) {
    const body = i === 0 && label ? `${label}\n\n${parts[i]}` : i === 0 ? `◆ wac\n\n${parts[i]}` : parts[i]
    try {
      await whatsapp.sendText(chatJid, body)
    } catch (error) {
      console.error(`failed to send chunk ${i + 1}/${parts.length}: ${format(error)}`)
    }
  }
}

function wacLabel(sessionId?: string, model?: string): string {
  const short = sessionId ? sessionId.slice(0, 8) : ""
  const parts: string[] = []
  if (short) parts.push(`_${short}_`)
  if (model) parts.push(`_${model}_`)
  if (parts.length === 0) return "◆ wac"
  return `◆ wac  ·  ${parts.join(" · ")}`
}

const chatQueues = new Map<string, Promise<void>>()

function enqueue<T>(chatJid: string, fn: () => Promise<T>): Promise<T> {
  const prev = chatQueues.get(chatJid) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chatQueues.set(chatJid, next.catch(() => undefined).then(() => undefined))
  return next
}

async function handleIncoming(
  whatsapp: WhatsAppClient,
  opencode: OpencodeClientFacade,
  router: SessionRouter,
  config: WacConfig,
  event: MessageEvent,
) {
  const { chatJid, senderJid, text, isGroup, fromMe } = event

  if (fromMe && !(await whatsapp.isAllowed(chatJid))) {
    return
  }
  if (isGroup) {
    return
  }
  const effectiveSender = fromMe ? chatJid : senderJid
  if (!(await whatsapp.isAllowed(effectiveSender))) {
    console.log(`ignoring message from non-allowlisted sender ${effectiveSender}`)
    return
  }

  await enqueue(chatJid, () => processMessage(whatsapp, opencode, router, config, event))
}

function effectiveModelFor(router: SessionRouter, config: WacConfig, chatJid: string): string | undefined {
  return router.chatSession(chatJid)?.model ?? config.defaultModel
}

async function processMessage(
  whatsapp: WhatsAppClient,
  opencode: OpencodeClientFacade,
  router: SessionRouter,
  config: WacConfig,
  event: MessageEvent,
) {
  const { chatJid, text } = event
  await whatsapp.startTyping(chatJid)
  try {
    if (isLocalCommand(text)) {
      const result = await handleCommand(router, opencode, config, chatJid, text)
      if (result.handled) {
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

    const result = await promptWithRetry(opencode, router, chatJid, record, text, config)
    await sendChunked(whatsapp, chatJid, result.text || "(no text reply)", wacLabel(record.sessionId, record.model ?? config.defaultModel))
  } catch (error) {
    console.error(`handler error: ${format(error)}`)
    const s = router.chatSession(chatJid)
    await sendChunked(whatsapp, chatJid, `(error) ${(error as Error).message}`, wacLabel(s?.sessionId, s?.model ?? config.defaultModel))
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
) {
  const effectiveModel = record.model ?? config.defaultModel
  if (!record.model && effectiveModel) {
    router.ensureModel(chatJid, effectiveModel)
    record.model = effectiveModel
  }
  const attempts = 3
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await opencode.prompt(record.sessionId, text, effectiveModel, config.systemPrompt)
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
      }
    }
  }
  throw lastError
}

function toJid(number: string): string {
  return number.includes("@") ? number : `${number.replace(/^\+/, "")}@s.whatsapp.net`
}

async function sendWelcome(whatsapp: WhatsAppClient, config: WacConfig) {
  const message = [
    `☘️ wac is online — send /help for commands, or just message me.`,
  ].join("\n")
  for (const number of config.allowlist) {
    try {
      await whatsapp.sendText(toJid(number), message)
      console.log(`sent welcome to ${number}`)
    } catch (error) {
      console.error(`failed to send welcome to ${number}: ${format(error)}`)
    }
  }
}

function killStaleInstances() {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process")
    const out = execSync('pgrep -f "node.*wac serve" || true', { encoding: "utf8" }).trim()
    if (!out) return
    const pids = out
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid)
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM")
        console.log(`killed stale wac instance ${pid}`)
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* best effort */
  }
}

async function cmdServe() {
  killStaleInstances()
  const config = ensureConfig()
  if (config.allowlist.length === 0) {
    fatal(`config "allowlist" is empty — add your WhatsApp number to ${configPath(config.dataDir)}`)
  }

  const store = new Store(config.dataDir)
  const opencode = new OpencodeClientFacade({
    baseUrl: config.opencodeBaseUrl,
    username: config.opencodeUsername,
    password: config.opencodePassword,
    directory: config.opencodeDirectory,
  })
  const router = new SessionRouter(opencode, store, config.defaultModel)
  const whatsapp = new WhatsAppClient(config, authPath(config.dataDir))
  let welcomeSent = false

  whatsapp.statusListener = (status, qr) => {
    const line =
      status === "open"
        ? "WhatsApp: connected"
        : status === "qr"
          ? "WhatsApp: needs QR — scan with your phone"
          : `WhatsApp: ${status}`
    console.log(line)
    if (status === "open" && !welcomeSent) {
      welcomeSent = true
      void sendWelcome(whatsapp, config)
    }
    void qr
  }

  whatsapp.messageListener = (event) => handleIncoming(whatsapp, opencode, router, config, event)

  const creds = await hasCredentials(authPath(config.dataDir))
  if (!creds) {
    console.log("No WhatsApp credentials yet — a QR will be shown. Scan it to link this device.")
  }

  const shutdown = async () => {
    console.log("shutting down…")
    await whatsapp.shutdown()
    store.flush()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

  const opencodeUp = await opencode.check()
  if (!opencodeUp) {
    console.log(`warning: opencode serve not reachable at ${config.opencodeBaseUrl} — will retry`)
    ensureOpenCodeServer(config)
  } else {
    console.log(`opencode serve: reachable at ${config.opencodeBaseUrl}`)
  }

  await whatsapp.start()
}

function ensureOpenCodeServer(config: WacConfig) {
  try {
    const url = new URL(config.opencodeBaseUrl)
    const port = url.port || "8080"
    const { spawn } = require("node:child_process") as typeof import("node:child_process")
    const opencodeBin = process.env.OPENCODE_BIN || `${process.env.HOME}/.opencode/bin/opencode`
    const env = { ...process.env }
    if (config.opencodePassword) env.OPENCODE_SERVER_PASSWORD = config.opencodePassword
    const child = spawn(opencodeBin, ["serve", "--hostname", "127.0.0.1", "--port", port], {
      stdio: "ignore",
      detached: true,
      env,
    })
    child.unref()
    console.log(`spawned opencode serve on :${port}`)
  } catch (error) {
    console.error(`could not spawn opencode serve: ${format(error)}`)
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

async function main() {
  const [command] = process.argv.slice(2)
  switch (command) {
    case "serve":
      return cmdServe()
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