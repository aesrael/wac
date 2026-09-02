import type { WacConfig } from "./config.js"
import { OpencodeClientFacade } from "./serve-client.js"
import type { SessionRouter } from "./sessions.js"

export type CommandResult =
  | { handled: true; text: string }
  | { handled: false; text?: undefined }

const LOCAL_COMMANDS = new Set(["/help", "/status", "/sessions", "/session", "/new", "/clear", "/model", "/models", "/compact", "/current", "/delete"])

export function isLocalCommand(text: string): boolean {
  const first = text.split(/\s+/, 1)[0]?.toLowerCase()
  if (!first || !first.startsWith("/")) return false
  return LOCAL_COMMANDS.has(first)
}

export function helpText(): string {
  return [
    "Commands:",
    "  /help       this help",
    "  /sessions   list opencode sessions",
    "  /session <id>  switch this chat to another session",
    "  /new        reset: create a fresh session",
    "  /clear      same as /new",
    "  /compact    compact the current session",
    "  /current    show the current session for this chat",
    "  /delete     delete the current session for this chat",
    "  /model <provider/model>  set model for this chat",
    "  /models [n] list available models (default 20)",
    "  /status     connection status",
    "Anything else is sent to opencode as a prompt.",
  ].join("\n")
}

export async function handleCommand(
  router: SessionRouter,
  client: OpencodeClientFacade,
  config: WacConfig,
  chatJid: string,
  text: string,
): Promise<CommandResult> {
  const [cmd, ...rest] = text.trim().split(/\s+/)
  const lower = cmd?.toLowerCase()
  const args = rest.join(" ").trim()

  switch (lower) {
    case "/help":
      return { handled: true, text: helpText() }

    case "/status": {
      const up = await client.check()
      return {
        handled: true,
        text: [
          `opencode serve: ${up ? "reachable" : "down (retrying)"}`,
          `base: ${config.opencodeBaseUrl}`,
          `auth: ${config.opencodePassword ? "basic auth on" : "no auth (loopback only)"}`,
          `sessions mapped: ${router.mappedCount()}`,
        ].join("\n"),
      }
    }

    case "/sessions": {
      const list = await router.listSessions()
      if (list.length === 0) return { handled: true, text: "No sessions yet." }
      const lines = list.map((s) => {
        const marker = s.chats.length > 0 ? s.chats.join(", ") : "unmapped"
        return `• ${s.sessionId}  ${s.title || "(untitled)"}  [${marker}]`
      })
      return { handled: true, text: lines.join("\n") }
    }

    case "/session": {
      if (!args) return { handled: true, text: "Usage: /session <session-id>\nGet ids from /sessions." }
      const record = await router.switchChat(chatJid, args)
      if (!record) return { handled: true, text: `No session found with id ${args}.` }
      return { handled: true, text: `Switched this chat to session ${args}.` }
    }

    case "/new":
    case "/clear": {
      const record = await router.createForChat(chatJid)
      return {
        handled: true,
        text: `Started a fresh session (${record.sessionId}). Previous conversation for this chat is kept on the server.`,
      }
    }

    case "/model": {
      const current = router.chatSession(chatJid)
      const effective = current?.model ?? config.defaultModel
      if (!args) {
        if (!effective) return { handled: true, text: "Model: (default — none set for this chat)" }
        const suffix = current?.model ? "" : " (default)"
        return { handled: true, text: `Model: ${effective}${suffix}` }
      }
      const record = await router.setModel(chatJid, args.replace(/\s+/g, ""))
      if (!record) return { handled: true, text: "No session for this chat yet; send a message first." }
      return { handled: true, text: `Model now: ${args}` }
    }

    case "/models": {
      const n = args ? parseInt(args, 10) : 20
      const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20
      const providers = await client.listProviders()
      const flat = providers.flatMap((p) => Object.keys(p.models).map((m) => `${p.id}/${m}`)).sort()
      if (flat.length === 0) return { handled: true, text: "No models returned by opencode." }
      const shown = flat.slice(0, limit)
      const more = flat.length > limit ? `\n… and ${flat.length - limit} more (use /models ${flat.length} to see all)` : ""
      return { handled: true, text: `Models (${shown.length}/${flat.length}):\n` + shown.map((m) => `• ${m}`).join("\n") + more }
    }

    case "/compact": {
      const record = router.chatSession(chatJid)
      if (!record) return { handled: true, text: "No session for this chat yet; send a message first." }
      const effective = record.model ?? config.defaultModel
      await client.summarize(record.sessionId, effective)
      return { handled: true, text: "Compacting session…" }
    }

    case "/current": {
      const record = router.chatSession(chatJid)
      if (!record) return { handled: true, text: "No session for this chat yet." }
      const effective = record.model ?? config.defaultModel
      const model = effective ? ` (model: ${effective}${record.model ? "" : " — default"})` : ""
      return { handled: true, text: `Session: ${record.sessionId}${model}` }
    }

    case "/delete": {
      const record = await router.deleteChatSession(chatJid)
      if (!record) return { handled: true, text: "No session for this chat yet." }
      return { handled: true, text: `Deleted session ${record.sessionId}. Next message will start a fresh one.` }
    }

    default:
      return { handled: false }
  }
}

export async function handlePassthrough(
  client: OpencodeClientFacade,
  sessionId: string,
  text: string,
): Promise<string> {
  const [cmd, ...rest] = text.trim().split(/\s+/)
  const args = rest.join(" ").trim()
  try {
    return await client.command(sessionId, cmd?.replace(/^\//, "") ?? "", args)
  } catch (error) {
    throw new Error(`opencode rejected command \`${cmd}\` (${(error as Error).message}). It is not a wac-local command.`)
  }
}