import { createOpencodeClient, OpencodeClient } from "@opencode-ai/sdk"
import type { AssistantMessage, Part, Session } from "@opencode-ai/sdk"

export type OpenCodeAuth = {
  baseUrl: string
  username: string
  password?: string
  directory: string
}

function data<T>(result: { data: T | undefined; error?: unknown }): T {
  if (result.data === undefined) {
    throw new Error(`opencode returned no data: ${JSON.stringify(result.error ?? "unknown")}`)
  }
  return result.data
}

function authHeader(auth: OpenCodeAuth): Record<string, string> | undefined {
  if (!auth.password) return undefined
  return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` }
}

/** Fast-op deadline: instant calls (get/list/command) must never hang the chat queue. */
export const FAST_OP_MS = 30_000
/** Abort deadline: cancelling stuck work is best-effort, never blocking. */
export const ABORT_OP_MS = 15_000

/**
 * Run an SDK call with a real deadline: the AbortSignal goes into fetch,
 * so the socket dies instead of lingering after the race rejects.
 * Slow-but-healthy calls (>5s) are logged for freeze diagnosis.
 */
async function withDeadline<T>(label: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
  const start = Date.now()
  try {
    return await fn(ctl.signal)
  } finally {
    clearTimeout(timer)
    const dt = Date.now() - start
    if (dt > 5000) console.log(`opencode ${label} took ${Math.round(dt / 1000)}s`)
  }
}

export function makeClient(auth: OpenCodeAuth): OpencodeClient {
  const url = new URL(auth.baseUrl)
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1"
  if (!loopback && url.protocol !== "https:") throw new Error("opencodeBaseUrl must use HTTPS unless it is loopback")
  return createOpencodeClient({
    baseUrl: url.toString() as `${string}://${string}`,
    headers: authHeader(auth),
    directory: auth.directory,
    throwOnError: true,
  })
}

export async function reachable(auth: OpenCodeAuth): Promise<boolean> {
  try {
    await makeClient(auth).session.list()
    return true
  } catch {
    return false
  }
}

export type PromptResult = {
  message: AssistantMessage
  text: string
  isEmpty: boolean
  error?: string | null
}

export function partsToText(parts: Part[]): string {
  const kept = parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && !p.synthetic)
  const text = kept.map((p) => p.text).join("").trim()
  return text
}

export function partsEmpty(parts: Part[]): boolean {
  // Tool-only turns (bash/edit with no text part) are real work, not errors.
  return parts.length === 0
}

function assistantError(info: AssistantMessage): string | null {
  if (!info.error) return null
  const e = info.error as { name?: string; message?: string; data?: { message?: string } }
  const msg = e.data?.message?.trim() ? e.data.message.trim() : e.message?.trim() ? e.message.trim() : e.name
  return msg ?? "unknown error"
}

export class OpencodeClientFacade {
  private client: OpencodeClient
  constructor(private readonly auth: OpenCodeAuth) {
    this.client = makeClient(auth)
  }

  async check(): Promise<boolean> {
    try {
      await withDeadline("check", FAST_OP_MS, (signal) => this.client.session.list({ signal } as never))
      return true
    } catch {
      return false
    }
  }

  async listSessions(): Promise<Session[]> {
    return withDeadline("list", FAST_OP_MS, async (signal) => data(await this.client.session.list({ signal } as never)))
  }

  async getSession(sessionId: string): Promise<Session> {
    return withDeadline("get", FAST_OP_MS, async (signal) =>
      data(await this.client.session.get({ path: { id: sessionId }, signal } as never)),
    )
  }

  async abortSession(sessionId: string): Promise<void> {
    // Best-effort: a wedged server must not hang the chat queue behind a cancel.
    await withDeadline("abort", ABORT_OP_MS, async (signal) => {
      await this.client.session.abort({ path: { id: sessionId }, signal } as never)
    })
  }

  async createSession(title?: string): Promise<Session> {
    const trimmed = title?.trim()
    return withDeadline("create", FAST_OP_MS, async (signal) =>
      data(await this.client.session.create({ body: trimmed ? { title: trimmed } : {}, signal } as never)),
    )
  }

  async prompt(
    sessionId: string,
    text: string,
    model?: string,
    system?: string,
    media?: { buffer: Buffer; mime: string; filename?: string } | { buffer: Buffer; mime: string; filename?: string }[],
    signal?: AbortSignal,
  ): Promise<PromptResult> {
    const providerID = model?.includes("/") ? model.slice(0, model.indexOf("/")) : undefined
    const modelID = model?.includes("/") ? model.slice(model.indexOf("/") + 1) : undefined
    const mediaList = media ? (Array.isArray(media) ? media : [media]) : []
    const parts: ({ type: "text"; text: string } | { type: "file"; mime: string; filename?: string; url: string })[] = []
    const effectiveText = text.trim() || (mediaList.length ? "Describe this image and answer any question about it." : text)
    if (effectiveText) parts.push({ type: "text", text: effectiveText } as const)
    for (const m of mediaList) {
      const b64 = m.buffer.toString("base64")
      const url = `data:${m.mime};base64,${b64}`
      parts.push({ type: "file", mime: m.mime, filename: m.filename ?? `file-${Date.now()}`, url })
    }
    if (parts.length === 0) parts.push({ type: "text", text })
    const result = data(
      await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: parts as never,
          ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
          ...(system ? { system } : {}),
        },
        ...(signal ? { signal } : {}),
      } as never),
    )
    return {
      message: result.info,
      text: partsToText(result.parts),
      isEmpty: partsEmpty(result.parts),
      error: assistantError(result.info),
    }
  }

  async command(sessionId: string, command: string, args: string): Promise<string> {
    const result = data(
      await withDeadline("command", FAST_OP_MS, async (signal) =>
        this.client.session.command({
          path: { id: sessionId },
          body: { command, arguments: args },
          signal,
        } as never),
      ),
    )
    if (typeof result === "string") return result
    if (result && typeof result === "object") {
      try {
        return JSON.stringify(result)
      } catch {
        /* fall through */
      }
    }
    return ""
  }

  async summarize(sessionId: string, model?: string): Promise<boolean> {
    const providerID = model?.includes("/") ? model.slice(0, model.indexOf("/")) : undefined
    const modelID = model?.includes("/") ? model.slice(model.indexOf("/") + 1) : undefined
    if (!providerID || !modelID) {
      const info = await this.getSession(sessionId)
      throw new Error(`no per-chat model set for session ${info.id}; use /model <provider/model> first`)
    }
    await withDeadline("summarize", FAST_OP_MS, async (signal) => {
      await this.client.session.summarize({
        path: { id: sessionId },
        body: { providerID, modelID },
        signal,
      } as never)
    })
    return true
  }

  async listProviders(): Promise<Array<{ id: string; models: Record<string, unknown> }>> {
    const data = await withDeadline("providers", FAST_OP_MS, async (signal) =>
      this.client.config.providers({ signal } as never),
    ) as unknown as { data?: unknown; error?: unknown }
    const raw = (data as { data?: unknown })?.data as unknown
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>
      if (Array.isArray((obj as { providers?: unknown }).providers)) {
        const arr = (obj as { providers: Array<{ id: string; models?: Record<string, unknown> }> }).providers
        return arr.map((p) => ({ id: p.id, models: p.models ?? {} }))
      }
      if (!Array.isArray(raw)) {
        // legacy: { providerId: { models: {...} } }
        return Object.entries(raw as Record<string, { models?: Record<string, unknown> }>).map(([id, v]) => ({
          id,
          models: v.models ?? {},
        }))
      }
    }
    const alt = await withDeadline("providers", FAST_OP_MS, async (signal) =>
      this.client.provider.list({ signal } as never),
    ) as unknown as { data?: unknown }
    const altData = (alt as { data?: unknown }).data as unknown
    if (altData && typeof altData === "object") {
      const aobj = altData as Record<string, unknown>
      if (Array.isArray(aobj.all)) {
        return (aobj.all as Array<{ id: string; models?: Record<string, unknown> }>).map((p) => ({ id: p.id, models: p.models ?? {} }))
      }
      if (Array.isArray(altData)) return (altData as Array<{ id: string; models?: Record<string, unknown> }>).map((p) => ({ id: p.id, models: p.models ?? {} }))
    }
    return []
  }

  async deleteSession(sessionId: string): Promise<void> {
    await withDeadline("delete", FAST_OP_MS, async (signal) => {
      await this.client.session.delete({ path: { id: sessionId }, signal } as never)
    })
  }

  async forkSession(sessionId: string, messageID?: string): Promise<Session> {
    const trimmed = messageID?.trim()
    return withDeadline("fork", FAST_OP_MS, async (signal) =>
      data(
        await this.client.session.fork({
          path: { id: sessionId },
          body: trimmed ? { messageID: trimmed } : {},
          signal,
        } as never),
      ),
    )
  }
}
