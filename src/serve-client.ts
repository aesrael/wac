import { OpenCode } from "@opencode/client"
import type {
  OpenCodeClient,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantText,
} from "@opencode/client"
import { Agent, fetch as undiciFetch } from "undici"

export type Session = SessionInfo

export type OpenCodeAuth = {
  baseUrl: string
  username: string
  password?: string
  directory: string
  requestTimeoutMs?: number
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
 * The v2 client rejects API failures with plain decoded objects
 * ({_tag, message, ...}), not Errors. Normalize to Error so every
 * `(error as Error).message` reader in wac prints something useful
 * instead of "[object Object]" / undefined. Abort signals pass through
 * untouched so /stop cancellation still classifies correctly.
 */
function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (error && typeof error === "object") {
    const e = error as { _tag?: unknown; message?: unknown; data?: { message?: unknown } }
    const message =
      (typeof e.data?.message === "string" && e.data.message) ||
      (typeof e.message === "string" && e.message) ||
      (typeof e._tag === "string" && e._tag) ||
      "unknown error"
    const tag = typeof e._tag === "string" ? e._tag : "OpencodeError"
    return new Error(`${message}`, { cause: tag })
  }
  return new Error(String(error))
}

/**
 * Run an API call with a real deadline: the AbortSignal goes into fetch,
 * so the socket dies instead of lingering after the race rejects.
 * Slow-but-healthy calls (>5s) are logged for freeze diagnosis.
 */
async function withDeadline<T>(label: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
  const start = Date.now()
  try {
    return await fn(ctl.signal)
  } catch (error) {
    throw toError(error)
  } finally {
    clearTimeout(timer)
    const dt = Date.now() - start
    if (dt > 5000) console.log(`opencode ${label} took ${Math.round(dt / 1000)}s`)
  }
}

export function makeClient(auth: OpenCodeAuth): OpenCodeClient {
  const url = new URL(auth.baseUrl)
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1"
  if (!loopback && url.protocol !== "https:") throw new Error("opencodeBaseUrl must use HTTPS unless it is loopback")
  const transportTimeoutMs = (auth.requestTimeoutMs ?? 300_000) + 30_000
  const dispatcher = new Agent({
    headersTimeout: transportTimeoutMs,
    bodyTimeout: transportTimeoutMs,
  })
  const transportFetch = (input: any, init?: any) => {
    if (typeof input === "string" || input instanceof URL) {
      return undiciFetch(input, { ...(init ?? {}), dispatcher })
    }
    const req = input as Request
    return undiciFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: (req.method === "GET" || req.method === "HEAD" ? undefined : (req as any).body ?? undefined) as any,
      signal: (req.signal ?? init?.signal) as any,
      redirect: (req as any).redirect,
      dispatcher,
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { duplex: "half" as const }),
    })
  }
  return OpenCode.make({
    baseUrl: url.toString(),
    headers: authHeader(auth),
    fetch: transportFetch as typeof fetch,
  })
}

export async function reachable(auth: OpenCodeAuth): Promise<boolean> {
  try {
    await makeClient(auth).session.list({ directory: auth.directory })
    return true
  } catch {
    return false
  }
}

export type PromptResult = {
  message: SessionMessageAssistant | undefined
  text: string
  isEmpty: boolean
  error?: string | null
}

type TextPart = { type: string; text?: string }

export function partsToText(parts: TextPart[]): string {
  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim()
  return text
}

export function partsEmpty(parts: TextPart[]): boolean {
  // Tool-only turns (bash/edit with no text part) are real work, not errors.
  return parts.length === 0
}

function toModelRef(model: string): { id: string; providerID: string } | undefined {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
}

export class OpencodeClientFacade {
  private client: OpenCodeClient
  constructor(private readonly auth: OpenCodeAuth) {
    this.client = makeClient(auth)
  }

  private location() {
    return { directory: this.auth.directory }
  }

  async check(): Promise<boolean> {
    try {
      await withDeadline("check", FAST_OP_MS, (signal) =>
        this.client.session.list({ directory: this.auth.directory }, { signal }),
      )
      return true
    } catch {
      return false
    }
  }

  async listSessions(): Promise<Session[]> {
    return withDeadline("list", FAST_OP_MS, async (signal) => {
      const res = await this.client.session.list({ directory: this.auth.directory }, { signal })
      return res.data
    })
  }

  async getSession(sessionId: string): Promise<Session> {
    return withDeadline("get", FAST_OP_MS, async (signal) =>
      this.client.session.get({ sessionID: sessionId }, { signal }),
    )
  }

  async abortSession(sessionId: string): Promise<void> {
    // Best-effort: a wedged server must not hang the chat queue behind a cancel.
    await withDeadline("abort", ABORT_OP_MS, async (signal) => {
      await this.client.session.interrupt({ sessionID: sessionId }, { signal })
    })
  }

  async createSession(title?: string, model?: string): Promise<Session> {
    const trimmed = title?.trim()
    return withDeadline("create", FAST_OP_MS, async (signal) =>
      this.client.session.create(
        {
          ...(trimmed ? { title: trimmed } : {}),
          location: this.location(),
          ...(model ? modelRefOrThrow(model) : {}),
        },
        { signal },
      ),
    )
  }

  /** Set the session model explicitly (v2 keeps model server-side, not per-prompt). */
  async switchModel(sessionId: string, model: string): Promise<void> {
    const ref = toModelRef(model)
    if (!ref) throw new Error(`bad model reference ${model}; want provider/model`)
    await withDeadline("model", FAST_OP_MS, async (signal) => {
      await this.client.session.switchModel({ sessionID: sessionId, model: ref }, { signal })
    })
  }

  async prompt(
    sessionId: string,
    text: string,
    model?: string,
    system?: string,
    media?: { buffer: Buffer; mime: string; filename?: string } | { buffer: Buffer; mime: string; filename?: string }[],
    signal?: AbortSignal,
  ): Promise<PromptResult> {
    const startedAt = Date.now()
    try {
      if (model) {
        const ref = toModelRef(model)
        if (!ref) throw new Error(`bad model reference ${model}; want provider/model`)
        await this.client.session.switchModel({ sessionID: sessionId, model: ref }, ...(signal ? [{ signal }] : []))
      }
      const mediaList = media ? (Array.isArray(media) ? media : [media]) : []
      const effectiveText = text.trim() || (mediaList.length ? "Describe this image and answer any question about it." : text)
      // v2 has no per-prompt system field: fold it into the message body ahead
      // of the user text, as it rode every turn under v1 as well.
      const body = system ? `${system}\n\n${effectiveText}` : effectiveText
      const files = mediaList.map((m) => ({
        uri: `data:${m.mime};base64,${m.buffer.toString("base64")}`,
        name: m.filename ?? `file-${Date.now()}`,
      }))
      const opts = signal ? { signal } : undefined
      const inbox = await this.client.session.prompt(
        { sessionID: sessionId, text: body || text, ...(files.length ? { files } : {}) },
        opts,
      )
      await this.client.session.wait({ sessionID: sessionId }, opts)
      const durationMs = Date.now() - startedAt
      if (durationMs > 5000) console.log(`opencode prompt session=${sessionId} took ${Math.round(durationMs / 1000)}s`)
      return await this.readLatestAssistant(sessionId, inbox.timeCreated, signal)
    } catch (error) {
      throw toError(error)
    }
  }

  private async readLatestAssistant(
    sessionId: string,
    since: number,
    signal?: AbortSignal,
  ): Promise<PromptResult> {
    const opts = signal ? { signal } : undefined
    const res = await this.client.message.list(
      { sessionID: sessionId, limit: 20, order: "desc", type: "assistant" },
      opts,
    )
    const message = res.data.find((m) => m.time.created >= since - 5000) as SessionMessageAssistant | undefined
    if (!message) {
      return { message: undefined, text: "", isEmpty: true, error: "no assistant reply recorded" }
    }
    const text = partsToText(message.content as TextPart[])
    const error =
      message.finish === "error"
        ? (message as { error?: { message?: string } }).error?.message ?? `model error (${message.rawFinish ?? "unknown"})`
        : null
    return { message, text, isEmpty: partsEmpty(message.content as TextPart[]), error }
  }

  async command(sessionId: string, command: string, args: string): Promise<string> {
    // v2 runs the command server-side and answers 204: the result lands as
    // assistant messages, so wait for idle and read the latest one.
    const startedAt = Date.now()
    await withDeadline("command", FAST_OP_MS, async (signal) => {
      await this.client.session.command({ sessionID: sessionId, command, text: args }, { signal })
      await this.client.session.wait({ sessionID: sessionId }, { signal })
    })
    const result = await this.readLatestAssistant(sessionId, startedAt)
    return result.text
  }

  async summarize(sessionId: string, model?: string): Promise<boolean> {
    // v2 compacts with the session's current model: pin the explicit one first.
    if (model) await this.switchModel(sessionId, model)
    await withDeadline("summarize", FAST_OP_MS, async (signal) => {
      await this.client.session.compact({ sessionID: sessionId }, { signal })
    })
    return true
  }

  async listProviders(): Promise<Array<{ id: string; models: Record<string, unknown> }>> {
    const [providers, models] = await withDeadline("providers", FAST_OP_MS, async (signal) => {
      const opts = { signal }
      const [p, m] = await Promise.all([
        this.client.provider.list(undefined, opts),
        this.client.model.list({ location: this.location() }, opts),
      ])
      return [p, m] as const
    })
    const byProvider = new Map<string, Record<string, unknown>>()
    for (const p of providers.data ?? []) byProvider.set(p.id, {})
    for (const m of models.data ?? []) {
      const entry = byProvider.get(m.providerID) ?? {}
      entry[m.modelID] = {}
      byProvider.set(m.providerID, entry)
    }
    return [...byProvider.entries()].map(([id, modelMap]) => ({ id, models: modelMap }))
  }

  async deleteSession(sessionId: string): Promise<void> {
    await withDeadline("delete", FAST_OP_MS, async (signal) => {
      await this.client.session.remove({ sessionID: sessionId }, { signal })
    })
  }

  async forkSession(sessionId: string, messageID?: string): Promise<Session> {
    const trimmed = messageID?.trim()
    try {
      return await withDeadline("fork", FAST_OP_MS, async (signal) =>
        this.client.session.fork(
          {
            sessionID: sessionId,
            boundary: trimmed ? { type: "before", messageID: trimmed } : { type: "through" },
          },
          { signal },
        ),
      )
    } catch (error) {
      // v2 refuses empty-session forks; say so plainly instead of a raw 4xx.
      if (/empty session/i.test(String((error as Error)?.message ?? error))) {
        throw new Error("nothing to fork yet — send a message first")
      }
      throw error
    }
  }
}

function modelRefOrThrow(model: string): { model: { id: string; providerID: string } } {
  const ref = toModelRef(model)
  if (!ref) throw new Error(`bad model reference ${model}; want provider/model`)
  return { model: ref }
}

// Re-exported for message-shape narrowing in tests.
export type { SessionMessageAssistantText }
