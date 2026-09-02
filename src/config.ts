import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080"
export const DEFAULT_USERNAME = "opencode"

export const DEFAULT_SYSTEM_PROMPT =
  "You are wac, an assistant reached over WhatsApp. Replies are delivered as WhatsApp text messages. " +
  "Keep responses concise and scannable: short paragraphs or brief bullet points, no long intros or apologies. " +
  "Use WhatsApp-native formatting where it helps: *bold*, _italic_, `inline code`, ```code blocks```, > quotes, and • bullet lists. " +
  "Avoid # headings and | tables | (render as plain lists instead). For links use plain https:// URLs as tappable links — never wrap URLs in `backticks` or [markdown](url) syntax. " +
  "Useful user commands: /help (list commands), /sessions (list sessions), /session <id> (switch), /new or /clear (fresh session), /model <provider/model> and /models [n] (model), /compact (summarize), /current (show session), /delete (remove), /status (connection). Explain them when asked. " +
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
  }
}

export const configPath = (dataDir: string) => join(dataDir, "config.json")
export const storePath = (dataDir: string) => join(dataDir, "store.json")
export const authPath = (dataDir: string) => join(dataDir, "auth")

export function ensureDataDir(wac: WacConfig) {
  mkdirSync(wac.dataDir, { recursive: true })
  mkdirSync(authPath(wac.dataDir), { recursive: true })
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
  const { allowlist, opencodeBaseUrl, opencodeUsername, opencodePassword, name, dataDir, systemPrompt, opencodeDirectory, defaultModel } =
    config
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify(
      { allowlist, opencodeBaseUrl, opencodeUsername, opencodePassword, name, systemPrompt, opencodeDirectory, defaultModel },
      null,
      2,
    ) + "\n",
  )
}