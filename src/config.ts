import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080"
export const DEFAULT_USERNAME = "opencode"

// Canonical wac-local command list — single source for the routing set
// (commands.ts) and the seed prompt's bare list (below). /wait is handled
// by the serial pipe in index.ts, not handleCommand, so commands.ts
// excludes it from routing (the early return there would swallow it).
export const WAC_COMMAND_ORDER = [
  "/help",
  "/sessions",
  "/session",
  "/new",
  "/clear",
  "/fork",
  "/stop",
  "/wait",
  "/restart",
  "/model",
  "/models",
  "/compact",
  "/current",
  "/delete",
  "/status",
] as const

export function promptCommandList(): string {
  return [...WAC_COMMAND_ORDER].join(" ")
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are wac, an assistant reached over WhatsApp. Replies are delivered as WhatsApp text messages. " +
  "Keep responses concise and scannable: short paragraphs or brief bullet points, no long intros or apologies. " +
  "Use WhatsApp-native formatting where it helps: *bold*, _italic_, `inline code`, ```code blocks```, > quotes, and • bullet lists. " +
  "Avoid # headings and | tables | (render as plain lists instead). For links use plain https:// URLs as tappable links — never wrap URLs in `backticks` or [markdown](url) syntax. " +
  "For approximations use the ≈ character — never use the tilde character for approx because in WhatsApp it renders as strikethrough. " +
  "Commands: " +
  promptCommandList() +
  " — explain only when asked. " +
  "Never use the interactive question/picker tool — WhatsApp is plain text only; ask options as a plain bullet list and accept a plain text reply. " +
  "To send an image, embed [image:/abs/path optional caption] inline with an absolute path. " +
  "To send any other file as a document, embed [file:/abs/path optional caption] the same way. " +
  "Use tools to verify — don't rush or skip verification to save time. " +
  "Answer directly, then stop."

export type WacConfig = {
  allowlist: string[]
  opencodeBaseUrl: string
  opencodeUsername: string
  opencodePassword?: string
  name: string
  dataDir: string
  systemPrompt: string
  opencodeDirectory: string
  defaultModel?: string
  promptTimeoutMs: number
  typingPulseMs: number
  welcomeOnConnect?: boolean
}

export function defaultConfig(): WacConfig {
  return {
    allowlist: [],
    opencodeBaseUrl: DEFAULT_BASE_URL,
    opencodeUsername: DEFAULT_USERNAME,
    name: "wac",
    dataDir: join(homedir(), ".config", "wac"),
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    opencodeDirectory: join(homedir(), "Desktop"),
    defaultModel: undefined,
    promptTimeoutMs: 15 * 60_000,
    typingPulseMs: 20_000,
    welcomeOnConnect: true,
  }
}

export const configPath = (dataDir: string) => join(dataDir, "config.json")
export const storePath = (dataDir: string) => join(dataDir, "store.json")
export const authPath = (dataDir: string) => join(dataDir, "auth")

export function ensureDataDir(wac: WacConfig) {
  mkdirSync(wac.dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(authPath(wac.dataDir), { recursive: true, mode: 0o700 })
  chmodSync(wac.dataDir, 0o700)
  chmodSync(authPath(wac.dataDir), 0o700)
}

export function loadConfig(overrides?: Partial<WacConfig>): WacConfig {
  const config = defaultConfig()
  const baseDir = overrides?.dataDir ?? config.dataDir
  const path = resolve(baseDir, "config.json")
  if (overrides?.dataDir) config.dataDir = baseDir

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WacConfig>
    config.allowlist = raw.allowlist ?? config.allowlist
    config.opencodeBaseUrl = raw.opencodeBaseUrl ?? config.opencodeBaseUrl
    config.opencodeUsername = raw.opencodeUsername ?? config.opencodeUsername
    config.opencodePassword = raw.opencodePassword ?? config.opencodePassword
    config.name = raw.name ?? config.name
    config.systemPrompt = raw.systemPrompt ?? config.systemPrompt
    config.opencodeDirectory = raw.opencodeDirectory ?? config.opencodeDirectory
    config.defaultModel = raw.defaultModel ?? config.defaultModel
    if (typeof raw.promptTimeoutMs === "number" && Number.isFinite(raw.promptTimeoutMs)) {
      const clamped = Math.min(30 * 60_000, Math.max(30_000, Math.floor(raw.promptTimeoutMs)))
      if (clamped !== Math.floor(raw.promptTimeoutMs)) {
        console.error(`config: promptTimeoutMs ${raw.promptTimeoutMs} clamped to ${clamped} (allowed 30000–1800000)`)
      }
      config.promptTimeoutMs = clamped
    }
    if (typeof raw.typingPulseMs === "number" && Number.isFinite(raw.typingPulseMs)) {
      const clamped = Math.min(60_000, Math.max(10_000, Math.floor(raw.typingPulseMs)))
      if (clamped !== Math.floor(raw.typingPulseMs)) {
        console.error(`config: typingPulseMs ${raw.typingPulseMs} clamped to ${clamped} (allowed 10000–60000)`)
      }
      config.typingPulseMs = clamped
    }
    config.welcomeOnConnect = raw.welcomeOnConnect ?? config.welcomeOnConnect
    if (raw.dataDir) config.dataDir = resolve(raw.dataDir)
  } catch (error) {
    throw new Error(`missing or invalid config at ${path}; create it from config.example.json`)
  }

  if (process.env.OPENCODE_SERVER_PASSWORD) {
    config.opencodePassword = process.env.OPENCODE_SERVER_PASSWORD
  }
  if (process.env.WAC_SYSTEM_PROMPT) {
    config.systemPrompt = process.env.WAC_SYSTEM_PROMPT
  }

  return config
}

export function writeConfig(config: WacConfig) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const { allowlist, opencodeBaseUrl, opencodeUsername, opencodePassword, name, dataDir, systemPrompt, opencodeDirectory, defaultModel, promptTimeoutMs, typingPulseMs, welcomeOnConnect } =
    config
  const path = join(dataDir, "config.json")
  const tmp = `${path}.tmp`
  const data =
    JSON.stringify(
      { allowlist, opencodeBaseUrl, opencodeUsername, opencodePassword, name, systemPrompt, opencodeDirectory, defaultModel, promptTimeoutMs, typingPulseMs, welcomeOnConnect },
      null,
      2,
    ) + "\n"
  // Atomic tmp+rename like Store.flush: a crash mid-write never truncates
  // config.json. Mode at creation closes the world-readable window.
  try {
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } catch {
    writeFileSync(path, data, { mode: 0o600 })
    chmodSync(path, 0o600)
  }
}
