import type { WacConfig } from "./config.js"
import { OpencodeClientFacade } from "./serve-client.js"
import type { SessionRouter } from "./sessions.js"

export type CommandResult =
  | { handled: true; text: string }
  | { handled: false; text?: undefined }

const LOCAL_COMMANDS = new Set(["/help", "/status", "/sessions", "/session", "/new", "/clear", "/fork", "/stop", "/model", "/models", "/compact", "/current", "/delete"])

export function isLocalCommand(text: string): boolean {
  const first = text.split(/\s+/, 1)[0]?.toLowerCase()
  if (!first || !first.startsWith("/")) return false
  return LOCAL_COMMANDS.has(first)
}

async function sessionByArg(router: SessionRouter, chatJid: string, arg: string, crossSession = true): Promise<string | undefined> {
  const list = crossSession ? await router.listSessions() : await router.listSessionsForChat(chatJid)
  const clean = arg.replace(/[[\]]/g, "").trim()
  if (/^\d+$/.test(clean)) {
    const picked = list[Number(clean)]
    return picked?.sessionId
  }
  return undefined
}

export function helpText(): string {
  return [
    "Commands:",
    "  /help       this help",
    "  /sessions   list opencode sessions",
    "  /session <id|[n]> switch this chat to another session (0 = current, 1 = previous, …)",
    "  /new        reset: create a fresh session",
    "  /clear      same as /new",
    "  /fork [message-id]  fork this chat's session at a message point (message-id from opencode, not a /sessions number)",
    "  /stop       cancel the currently running work in this chat's session",
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
      const current = router.chatSession(chatJid)?.sessionId
      const lines = list.map((s, i) => {
        const mine = current ? s.sessionId === current : false
        const tag = mine ? " ← this chat" : s.chats.length > 0 ? " ← other chat" : " (unmapped)"
        return `${i} · ${s.title || "(untitled)"}  (${s.sessionId.slice(0, 8)})${tag}`
      })
      return { handled: true, text: lines.join("\n") }
    }

    case "/session": {
      if (!args) return { handled: true, text: "Usage: /session <id|[n]>\nGet numbers from /sessions." }
      let target = args
      const byIndex = await sessionByArg(router, chatJid, args)
      if (byIndex) target = byIndex
      const record = await router.switchChat(chatJid, target)
      if (!record) return { handled: true, text: `No session found with id ${args}.` }
      return { handled: true, text: `Switched this chat to session ${record.sessionId}.` }
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
      const candidate = args.replace(/\s+/g, "")
      let flat: string[] = []
      try {
        const dirties = await client.listProviders()
        flat = dirties.flatMap((p) => Object.keys(p.models).map((m) => `${p.id}/${m}`))
      } catch {
        // opencode down: accept the value unvalidated rather than blocking.
        const record = await router.setModel(chatJid, candidate)
        if (!record) return { handled: true, text: "No session for this chat yet; send a message first." }
        const first = !record.sessionId ? " (will apply to your next message)" : ""
        return { handled: true, text: `Model now: ${args}${first} (unvalidated — opencode unreachable)` }
      }
      if (flat.length > 0 && !flat.includes(candidate)) return { handled: true, text: `Unknown model ${args}. Not set. Use /models to list valid ones.` }
      const record = await router.setModel(chatJid, candidate)
      if (!record) return { handled: true, text: "No session for this chat yet; send a message first." }
      const first = !record.sessionId ? " (will apply to your next message)" : ""
      return { handled: true, text: `Model now: ${args}${first}` }
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
      let sid = router.chatSession(chatJid)?.sessionId
      if (!sid) return { handled: true, text: "No session for this chat yet; send a message first." }
      if (args) {
        const target = await sessionByArg(router, chatJid, args)
        if (!target) return { handled: true, text: `No session at index ${args}. Use /sessions to list.` }
        sid = target
      }
      const effective = router.chatSession(chatJid)?.model ?? config.defaultModel
      await client.summarize(sid, effective)
      return { handled: true, text: `Compacting ${sid.slice(0, 8)}…` }
    }

    case "/current": {
      const record = router.chatSession(chatJid)
      if (!record) return { handled: true, text: "No session for this chat yet." }
      const effective = record.model ?? config.defaultModel
      const model = effective ? ` (model: ${effective}${record.model ? "" : " — default"})` : ""
      return { handled: true, text: `Session: ${record.sessionId}${model}` }
    }

    case "/delete": {
      if (args) {
        const parts = args.split(/\s+/)
        const confirm = parts[parts.length - 1]?.toLowerCase() === "confirm"
        const targetArg = confirm ? parts.slice(0, -1).join(" ") : args
        const target = await sessionByArg(router, chatJid, targetArg)
        if (!target) return { handled: true, text: `No session at index ${targetArg}. Use /sessions to list.` }
        // Cross-chat deletes are destructive: require explicit confirm.
        const cur = router.chatSession(chatJid)
        if (cur?.sessionId !== target && !confirm) {
          return { handled: true, text: `That session (${target.slice(0, 8)}) is not this chat's. Resend as \`/delete ${targetArg} confirm\` to delete it.` }
        }
        await client.deleteSession(target)
        // if it was this chat's session, clear the mapping too
        if (cur?.sessionId === target) await router.deleteChatSession(chatJid)
        return { handled: true, text: `Deleted session ${target.slice(0, 8)}. Next message will start a fresh one.` }
      }
      const record = await router.deleteChatSession(chatJid)
      if (!record) return { handled: true, text: "No session for this chat yet." }
      return { handled: true, text: `Deleted session ${record.sessionId}. Next message will start a fresh one.` }
    }

    case "/fork": {
      if (/^\d+$/.test(args)) {
        return { handled: true, text: "Usage: /fork [message-id]\nThat takes an opencode message ID, not a /sessions number. Omit it to fork at the latest message." }
      }
      const record = await router.forkChat(chatJid, args || undefined)
      if (!record) return { handled: true, text: "No session for this chat yet; send a message first." }
      return { handled: true, text: `Forked this chat to session ${record.sessionId}. Previous conversation is kept on the server.` }
    }

    case "/stop": {
      const current = router.chatSession(chatJid)
      if (!current) return { handled: true, text: "No session for this chat yet." }
      try {
        await client.abortSession(current.sessionId)
      } catch (error) {
        return { handled: true, text: `Could not cancel: ${(error as Error).message}` }
      }
      return { handled: true, text: `Cancelled running work in ${current.sessionId.slice(0, 8)}. Send a message to continue.` }
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
