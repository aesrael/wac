import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
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
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoreData>
      return { version: 1, chats: raw.chats ?? {} }
    } catch {
      return { version: 1, chats: {} }
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
