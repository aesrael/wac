import type { WacConfig } from "./config.js"
import { writeConfig } from "./config.js"
import { OpencodeClientFacade } from "./serve-client.js"
import type { SessionRouter } from "./sessions.js"
import type { ChatSession } from "./store.js"

export type CommandResult =
  | { handled: true; text: string; restart?: boolean }
  | { handled: false; text?: undefined }

const LOCAL_COMMANDS = new Set(["/help", "/status", "/sessions", "/session", "/new", "/clear", "/fork", "/stop", "/model", "/models", "/compact", "/current", "/delete", "/restart"])

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

async function sessionInfoText(
  client: OpencodeClientFacade,
  config: WacConfig,
  record: ChatSession,
  heading: string,
  showId = true,
): Promise<string> {
  const effective = record.model ?? config.defaultModel
  // Live server title wins — the store copy goes stale when opencode renames sessions.
  let title = record.title?.trim() ?? ""
  let created = 0
  try {
    if (record.sessionId) {
      const live = await client.getSession(record.sessionId)
      if (live.title?.trim()) title = live.title.trim()
      created = live.time?.created ?? 0
    }
  } catch {
    /* opencode down: fall back to stored title */
  }
  const fmtDate = (ms: number) => {
    if (!ms) return "unknown"
    try {
      return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    } catch {
      return "unknown"
    }
  }
  const lines = [
    heading,
    ...(showId ? [`• *Session:* \`${record.sessionId}\``] : []),
    `• *Title:* ${title || "untitled"}`,
    `• *Model:* ${effective ?? "default"}${effective && !record.model ? " (default)" : ""}`,
    `• *Created:* ${fmtDate(created)}`,
  ]
  return lines.join("\n")
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
    "  /restart    restart the wac daemon (opencode untouched)",
    "  /compact    compact the current session",
    "  /current    show the current session for this chat",
    "  /delete     delete the current session for this chat",
    "  /model <provider/model>  set model for this chat",
    "  /model default <provider/model>  set global default (new chats use it)",
    "  /models [query] [n] search/list available models (default 20)",
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
  opts?: { onStop?: (chatJid: string) => boolean },
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
      return { handled: true, text: await sessionInfoText(client, config, record, `*Switched to session \`${record.sessionId.slice(0, 8)}\`*`, false) }
    }

    case "/new":
    case "/clear": {
      const record = await router.createForChat(chatJid)
      return {
        handled: true,
        text: `Started a fresh session (${record.sessionId.slice(0, 8)}). Previous conversation for this chat is kept on the server.`,
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
      const [head, ...restArgs] = args.split(/\s+/)
      if (head?.toLowerCase() === "default") {
        const value = restArgs.join(" ").trim()
        if (!value) {
          return {
            handled: true,
            text: config.defaultModel
              ? `Default model: ${config.defaultModel}`
              : "Default model: (none set)",
          }
        }
        const candidate = value.replace(/\s+/g, "")
        try {
          const providers = await client.listProviders()
          const flat = providers.flatMap((p) => Object.keys(p.models).map((m) => `${p.id}/${m}`))
          if (flat.length > 0 && !flat.includes(candidate)) {
            return { handled: true, text: `Unknown model ${value}. Default not set. Use /models to list valid ones.` }
          }
        } catch {
          return { handled: true, text: `(error) opencode unreachable — default not set. Retry when back.` }
        }
        config.defaultModel = candidate
        try {
          writeConfig(config)
        } catch (error) {
          return { handled: true, text: `(error) could not save default model (${(error as Error).message})` }
        }
        return { handled: true, text: `Default model now: ${candidate}. New chats use it immediately, no restart needed.` }
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
      const tokens = args ? args.split(/\s+/) : []
      let limit = 20
      const queryParts: string[] = []
      for (const t of tokens) {
        const num = parseInt(t, 10)
        if (String(num) === t && Number.isFinite(num) && num > 0) limit = Math.min(num, 100)
        else queryParts.push(t)
      }
      const query = queryParts.join(" ").toLowerCase()
      const providers = await client.listProviders()
      const all = providers.flatMap((p) => Object.keys(p.models).map((m) => `${p.id}/${m}`)).sort()
      if (all.length === 0) return { handled: true, text: "No models returned by opencode." }
      const flat = query ? all.filter((m) => m.toLowerCase().includes(query)) : all
      if (flat.length === 0) return { handled: true, text: `No models match "${queryParts.join(" ")}".` }
      const shown = flat.slice(0, limit)
      const scope = query ? ` matching "${queryParts.join(" ")}"` : ""
      const hint = query ? `${queryParts.join(" ")} ` : ""
      const more = flat.length > limit ? `\n… and ${flat.length - limit} more (use /models ${hint}${flat.length} to see all)` : ""
      return { handled: true, text: `Models (${shown.length}/${flat.length}${scope}):\n` + shown.map((m) => `• ${m}`).join("\n") + more }
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
      return { handled: true, text: await sessionInfoText(client, config, record, "*Current session*") }
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
        let serverDeleted = true
        try {
          await client.deleteSession(target)
        } catch {
          serverDeleted = false
        }
        // if it was this chat's session, clear the mapping and eagerly start a
        // fresh one, so the reply below is always true (lazy "next message
        // will..." breaks when opencode is unreachable at that moment).
        if (cur?.sessionId === target) {
          const model = cur.model ?? config.defaultModel
          await router.deleteChatSession(chatJid)
          if (!serverDeleted) {
            return { handled: true, text: `Mapping to ${target.slice(0, 8)} cleared, but it may still exist on the server — it can show as unmapped in /sessions.` }
          }
          try {
            const fresh = await router.createForChat(chatJid, undefined, model)
            return { handled: true, text: `Deleted ${target.slice(0, 8)}, started fresh session ${fresh.sessionId.slice(0, 8)}.` }
          } catch {
            return { handled: true, text: `Deleted session ${target.slice(0, 8)}. Could not start a fresh one (opencode unreachable) — your next message will create it.` }
          }
        }
        const tail = serverDeleted
          ? "It was not this chat's session, so this chat is untouched."
          : "It may still exist on the server — it can show as unmapped in /sessions."
        return { handled: true, text: `Deleted session ${target.slice(0, 8)}. ${tail}` }
      }
      const res = await router.deleteChatSession(chatJid)
      if (!res) return { handled: true, text: "No session for this chat yet." }
      if (!res.serverDeleted) {
        return { handled: true, text: `Mapping to ${res.record.sessionId.slice(0, 8)} cleared, but it may still exist on the server — it can show as unmapped in /sessions.` }
      }
      // Eager fresh session: the old lazy "next message will start a fresh
      // one" broke whenever opencode was unreachable at that moment.
      // Per-chat model is preserved explicitly (the mapping is already gone).
      const model = res.record.model ?? config.defaultModel
      try {
        const fresh = await router.createForChat(chatJid, undefined, model)
        return { handled: true, text: `Deleted ${res.record.sessionId.slice(0, 8)}, started fresh session ${fresh.sessionId.slice(0, 8)}.` }
      } catch {
        return { handled: true, text: `Deleted session ${res.record.sessionId.slice(0, 8)}. Could not start a fresh one (opencode unreachable) — your next message will create it.` }
      }
    }

    case "/fork": {
      if (/^\d+$/.test(args)) {
        return { handled: true, text: "Usage: /fork [message-id]\nThat takes an opencode message ID, not a /sessions number. Omit it to fork at the latest message." }
      }
      const record = await router.forkChat(chatJid, args || undefined)
      if (!record) return { handled: true, text: "No session for this chat yet; send a message first." }
      return { handled: true, text: `Forked this chat to session ${record.sessionId.slice(0, 8)}. Previous conversation is kept on the server.` }
    }

    case "/stop": {
      const current = router.chatSession(chatJid)
      if (!current) return { handled: true, text: "No session for this chat yet." }
      try {
        await client.abortSession(current.sessionId)
      } catch (error) {
        return { handled: true, text: `Could not cancel: ${(error as Error).message}` }
      }
      const freed = opts?.onStop?.(chatJid) ?? false
      return {
        handled: true,
        text: freed
          ? `Cancelled running work in ${current.sessionId.slice(0, 8)} and freed the queue. Send a message to continue — /restart if it stays stuck.`
          : `Cancelled running work in ${current.sessionId.slice(0, 8)}. Send a message to continue — /restart if it stays stuck.`,
      }
    }

    case "/restart": {
      return { handled: true, text: "Restarting wac… back in seconds. Opencode sessions untouched.", restart: true }
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
