import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080"
export const DEFAULT_USERNAME = "opencode"

export const DEFAULT_SYSTEM_PROMPT =
  "You are wac, an assistant reached over WhatsApp. Replies are delivered as WhatsApp text messages. " +
  "Keep responses concise and scannable: short paragraphs or brief bullet points, no long intros or apologies. " +
  "Use WhatsApp-native formatting where it helps: *bold*, _italic_, `inline code`, ```code blocks```, > quotes, and • bullet lists. " +
  "Avoid # headings and | tables | (render as plain lists instead). For links use plain https:// URLs as tappable links — never wrap URLs in `backticks` or [markdown](url) syntax. " +
  "Useful user commands: /help (list commands), /sessions (list sessions), /session <id> (switch), /new or /clear (fresh session), /fork [message-id] (fork at message), /stop (cancel running work), /model <provider/model> and /models [n] (model), /compact (summarize), /current (show session), /delete (remove), /status (connection). Explain them when asked. " +
  "Work within a reply window stated per request (typically several minutes): prefer complete, correct answers and use the tools you need — don't rush or skip verification to save time. Only if a task genuinely won't fit in the window, send the best result so far plus the single next step to continue in a follow-up. " +
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
  mkdirSync(config.dataDir, { recursive: true })
  const { allowlist, opencodeBaseUrl, opencodeUsername, opencodePassword, name, dataDir, systemPrompt, opencodeDirectory, defaultModel, promptTimeoutMs, welcomeOnConnect } =
    config
  const path = join(dataDir, "config.json")
  writeFileSync(
    path,
    JSON.stringify(
      { allowlist, opencodeBaseUrl, opencodeUsername, opencodePassword, name, systemPrompt, opencodeDirectory, defaultModel, promptTimeoutMs, welcomeOnConnect },
      null,
      2,
    ) + "\n",
  )
  chmodSync(path, 0o600)
}
