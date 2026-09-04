import { OpencodeClientFacade } from "./serve-client.js"
import { Store, type ChatSession } from "./store.js"

export class SessionRouter {
  constructor(
    private readonly client: OpencodeClientFacade,
    private readonly store: Store,
    private readonly defaultModel?: string,
  ) {}

  async resolve(chatJid: string): Promise<ChatSession> {
    const existing = this.store.get(chatJid)
    if (existing?.sessionId) {
      try {
        const serverSession = await this.client.getSession(existing.sessionId)
        if (serverSession) return existing
      } catch {
        /* mapped session is gone server-side (e.g. opencode serve restarted and
           lost its sessions); fall through and recreate a fresh one */
      }
      return await this.createForChat(chatJid, existing.title, existing.model ?? this.defaultModel)
    }

    const session = await this.createForChat(chatJid, undefined, this.defaultModel)
    return session
  }

  async createForChat(chatJid: string, title?: string, model?: string): Promise<ChatSession> {
    const effectiveTitle = title && title.trim() ? title.trim() : undefined
    const session = await this.client.createSession(effectiveTitle)
    const effectiveModel = model ?? this.store.get(chatJid)?.model ?? this.defaultModel
    const record: ChatSession = {
      sessionId: session.id,
      title: title ?? session.title ?? "",
      ...(effectiveModel ? { model: effectiveModel } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.store.set(chatJid, record)
    return record
  }

  async switchChat(chatJid: string, sessionIdOrPrefix: string): Promise<ChatSession | undefined> {
    let sessionId = sessionIdOrPrefix
    // numeric index -> the session in that line of the /sessions listing (0-based)
    if (/^\d+$/.test(sessionIdOrPrefix)) {
      const idx = Number(sessionIdOrPrefix)
      const list = await this.listSessions()
      const picked = list[idx]
      if (!picked) return undefined
      sessionId = picked.sessionId
    }
    try {
      await this.client.getSession(sessionId)
    } catch {
      const matches = (await this.client.listSessions()).filter((s) => s.id.startsWith(sessionIdOrPrefix))
      if (matches.length !== 1) return undefined
      sessionId = matches[0].id
    }
    const session = await this.client.getSession(sessionId)
    if (!session) return undefined
    const previous = this.store.get(chatJid)
    const effectiveModel = previous?.model ?? this.defaultModel
    const record: ChatSession = {
      sessionId,
      title: session.title || sessionId,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.store.set(chatJid, record)
    return record
  }

  async setModel(chatJid: string, model: string): Promise<ChatSession | undefined> {
    const existing = this.store.get(chatJid)
    if (!existing) {
      // No session yet: persist a pending model so the next message uses it.
      // resolve() picks up existing.model when it creates the session.
      const pending: ChatSession = {
        sessionId: "",
        title: "",
        model,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      this.store.set(chatJid, pending)
      return pending
    }
    existing.model = model
    existing.updatedAt = Date.now()
    this.store.set(chatJid, existing)
    return existing
  }

  ensureModel(chatJid: string, fallback?: string): ChatSession | undefined {
    const existing = this.store.get(chatJid)
    if (!existing || existing.model || !fallback) return existing
    existing.model = fallback
    existing.updatedAt = Date.now()
    this.store.set(chatJid, existing)
    return existing
  }

  chatSession(chatJid: string): ChatSession | undefined {
    return this.store.get(chatJid)
  }

  mappedCount(): number {
    return Object.keys(this.store.all()).length
  }

  async listSessionsForChat(chatJid: string): Promise<Array<{ sessionId: string; title: string; chats: string[] }>> {
    const current = this.store.get(chatJid)
    if (!current) return []
    return (await this.listSessions()).filter((s) => s.sessionId === current.sessionId)
  }

  async deleteChatSession(chatJid: string): Promise<ChatSession | undefined> {
    const record = this.store.get(chatJid)
    if (!record) return undefined
    try {
      await this.client.deleteSession(record.sessionId)
    } catch {
      /* session may already be gone server-side; still clear the mapping */
    }
    this.store.delete(chatJid)
    return record
  }

  async forkChat(chatJid: string, messageID?: string): Promise<ChatSession | undefined> {
    const existing = this.store.get(chatJid)
    if (!existing) return undefined
    const forked = await this.client.forkSession(existing.sessionId, messageID)
    const record: ChatSession = {
      sessionId: forked.id,
      title: forked.title || existing.title || forked.id,
      ...(existing.model ? { model: existing.model } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.store.set(chatJid, record)
    return record
  }

  async listSessions(): Promise<Array<{ sessionId: string; title: string; chats: string[] }>> {
    const server = await this.client.listSessions()
    const byId = new Map(server.map((s) => [s.id, s]))
    const result: Array<{ sessionId: string; title: string; chats: string[] }> = []
    for (const [chat, record] of Object.entries(this.store.all())) {
      if (!record.sessionId) continue // pending /model preset, no server session yet
      const meta = byId.get(record.sessionId)
      result.push({
        sessionId: record.sessionId,
        title: meta?.title || record.title,
        chats: [chat],
      })
      byId.delete(record.sessionId)
    }
    for (const [id, meta] of byId) {
      result.push({ sessionId: id, title: meta.title || id, chats: [] })
    }
    return result
  }
}
