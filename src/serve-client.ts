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

export function makeClient(auth: OpenCodeAuth): OpencodeClient {
  return createOpencodeClient({
    baseUrl: auth.baseUrl as `${string}://${string}`,
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
}

export function partsToText(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("")
    .trim()
}

export class OpencodeClientFacade {
  private client: OpencodeClient
  constructor(private readonly auth: OpenCodeAuth) {
    this.client = makeClient(auth)
  }

  async check(): Promise<boolean> {
    try {
      await this.client.session.list()
      return true
    } catch {
      return false
    }
  }

  async listSessions(): Promise<Session[]> {
    return data(await this.client.session.list())
  }

  async getSession(sessionId: string): Promise<Session> {
    return data(await this.client.session.get({ path: { id: sessionId } }))
  }

  async createSession(title?: string): Promise<Session> {
    const trimmed = title?.trim()
    return data(await this.client.session.create({ body: trimmed ? { title: trimmed } : {} }))
  }

  async prompt(
    sessionId: string,
    text: string,
    model?: string,
    system?: string,
    media?: { buffer: Buffer; mime: string; filename?: string } | { buffer: Buffer; mime: string; filename?: string }[],
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
      }),
    )
    return {
      message: result.info,
      text: partsToText(result.parts),
    }
  }

  async command(sessionId: string, command: string, args: string): Promise<string> {
    const result = data(
      await this.client.session.command({
        path: { id: sessionId },
        body: { command, arguments: args },
      }),
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
      const info = data(await this.client.session.get({ path: { id: sessionId } }))
      throw new Error(`no per-chat model set for session ${info.id}; use /model <provider/model> first`)
    }
    await this.client.session.summarize({
      path: { id: sessionId },
      body: { providerID, modelID },
    })
    return true
  }

  async listProviders(): Promise<Array<{ id: string; models: Record<string, unknown> }>> {
    const data = await this.client.config.providers() as unknown as { data?: unknown; error?: unknown }
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
    const alt = await this.client.provider.list() as unknown as { data?: unknown }
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
    await this.client.session.delete({ path: { id: sessionId } })
  }

  async forkSession(sessionId: string, messageID?: string): Promise<Session> {
    const trimmed = messageID?.trim()
    return data(
      await this.client.session.fork({
        path: { id: sessionId },
        body: trimmed ? { messageID: trimmed } : {},
      }),
    )
  }
}