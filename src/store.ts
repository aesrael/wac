import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type ChatSession = {
  sessionId: string
  title: string
  model?: string
  createdAt: number
  updatedAt: number
}

export type StoreData = {
  version: 1
  chats: Record<string, ChatSession>
}

export class Store {
  private data: StoreData
  private readonly path: string
  private readonly dir: string
  private saveTimer: NodeJS.Timeout | undefined

  constructor(dir: string) {
    this.dir = dir
    this.path = join(dir, "store.json")
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
    this.data = this.read()
  }

  private read(): StoreData {
    let rawText: string
    try {
      rawText = readFileSync(this.path, "utf8")
    } catch (error) {
      // Missing file on first run is fine. Anything else (EPERM, EISDIR…)
      // fails closed: never reset mappings silently.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, chats: {} }
      throw new Error(`wac store unreadable at ${this.path}: ${(error as Error).message} — refusing to reset mappings`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch (error) {
      this.backupCorrupt(rawText)
      throw new Error(
        `wac store corrupt at ${this.path} — original preserved, backup written alongside it. Fix or move it aside to start fresh: ${(error as Error).message}`,
      )
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.backupCorrupt(rawText)
      throw new Error(`wac store corrupt at ${this.path} — expected {"chats":{…}}, got non-object. Original preserved, backup written.`)
    }
    const chats = (parsed as Partial<StoreData>).chats
    if (chats === undefined) return { version: 1, chats: {} }
    if (!chats || typeof chats !== "object" || Array.isArray(chats)) {
      this.backupCorrupt(rawText)
      throw new Error(`wac store corrupt at ${this.path} — "chats" is not an object. Original preserved, backup written.`)
    }
    return { version: 1, chats: chats as Record<string, ChatSession> }
  }

  /** Best-effort copy of the bad file next to the original. Never throws. */
  private backupCorrupt(rawText: string) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-")
      const backup = `${this.path}.corrupt-${ts}.bak`
      try {
        copyFileSync(this.path, backup)
      } catch {
        writeFileSync(backup, rawText)
      }
      chmodSync(backup, 0o600)
      console.error(`wac store corrupt — original preserved at ${this.path}, copy at ${backup}`)
    } catch {
      /* original error below is what matters */
    }
  }

  get(chatJid: string): ChatSession | undefined {
    return this.data.chats[chatJid]
  }

  set(chatJid: string, session: ChatSession) {
    this.data.chats[chatJid] = session
    // Flush synchronously: the store is tiny, and a SIGKILLed twin (see
    // killStaleInstances) would otherwise lose mappings saved <50ms ago.
    this.flush()
  }

  delete(chatJid: string) {
    if (!this.data.chats[chatJid]) return
    delete this.data.chats[chatJid]
    this.flush()
  }

  all(): Record<string, ChatSession> {
    return this.data.chats
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n")
      renameSync(tmp, this.path)
      chmodSync(this.path, 0o600)
    } catch {
      writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n")
      chmodSync(this.path, 0o600)
    }
  }
}
