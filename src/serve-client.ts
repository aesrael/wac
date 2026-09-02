import { createOpencodeClient, OpencodeClient } from "@opencode-ai/sdk"
import type { AssistantMessage, Part, Session } from "@opencode-ai/sdk"

export type OpenCodeAuth = {
  baseUrl: string
  username: string
  password?: string
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

  async createSession(title: string): Promise<Session> {
    return data(await this.client.session.create({ body: { title } }))
  }

  async prompt(sessionId: string, text: string, model?: string, system?: string): Promise<PromptResult> {
    const [providerID, modelID] = model?.split("/", 2) ?? []
    const result = data(
      await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
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
    const [providerID, modelID] = model?.split("/", 2) ?? []
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

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.session.delete({ path: { id: sessionId } })
  }
}