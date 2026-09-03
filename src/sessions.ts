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
    if (existing) {
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
    const effectiveTitle = title && title.trim() ? title : undefined
    const session = effectiveTitle ? await this.client.createSession(effectiveTitle) : await this.client.createSession("")
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
    try {
      await this.client.getSession(sessionIdOrPrefix)
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
    if (!existing) return undefined
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

  async listSessions(): Promise<Array<{ sessionId: string; title: string; chats: string[] }>> {
    const server = await this.client.listSessions()
    const byId = new Map(server.map((s) => [s.id, s]))
    const result: Array<{ sessionId: string; title: string; chats: string[] }> = []
    for (const [chat, record] of Object.entries(this.store.all())) {
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