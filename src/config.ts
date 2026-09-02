import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080"
export const DEFAULT_USERNAME = "opencode"

export const DEFAULT_SYSTEM_PROMPT =
  "You are wac, an assistant reached over WhatsApp. Replies are delivered as plain WhatsApp text messages. " +
  "Keep responses concise and scannable: short paragraphs or brief bullet points, no long intros or apologies. " +
  "Avoid heavy markdown that WhatsApp cannot render (no # headings, no tables, no ``` code fences, no [links](url) " +
  "syntax); plain text is best. Answer the question directly, then stop."

export type WacConfig = {
  allowlist: string[]
  opencodeBaseUrl: string
  opencodeUsername: string
  opencodePassword?: string
  name: string
  dataDir: string
  systemPrompt: string
}

export function defaultConfig(): WacConfig {
  return {
    allowlist: [],
    opencodeBaseUrl: DEFAULT_BASE_URL,
    opencodeUsername: DEFAULT_USERNAME,
    name: "wac",
    dataDir: join(homedir(), ".config", "wac"),
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
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
    if (raw.dataDir) config.dataDir = resolve(raw.dataDir)
  } catch (error) {
    throw new Error(`missing or invalid config at ${path}; create it from config.example.json`)
  }

  if (process.env.OPENCODE_SERVER_PASSWORD) {
    config.opencodePassword = process.env.OPENCODE_SERVER_PASSWORD
  }

  return config
}

export function writeConfig(config: WacConfig) {
  mkdirSync(config.dataDir, { recursive: true })
  const { allowlist, opencodeBaseUrl, opencodeUsername, opencodePassword, name, dataDir } = config
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({ allowlist, opencodeBaseUrl, opencodeUsername, opencodePassword, name }, null, 2) + "\n",
  )
}