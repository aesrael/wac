import makeWASocket, {
  DisconnectReason,
  type AnyMessageContent,
  type ConnectionState,
  type WAMessage,
  downloadMediaMessage,
} from "@whiskeysockets/baileys"
import { useMultiFileAuthState } from "@whiskeysockets/baileys"
import QRCode from "qrcode-terminal"
import { readFile } from "node:fs/promises"
import { WacConfig } from "./config.js"

export type ConnectionStatus = "connecting" | "open" | "close" | "qr"

export type MessageEvent = {
  messageId: string
  chatJid: string
  senderJid: string
  text: string
  /** text of the WhatsApp message this was sent as a reply to, if any */
  quoted?: string
  isGroup: boolean
  fromMe: boolean
  /** true when recovered from history/backfill after a reconnect, not live delivery */
  fromHistory?: boolean
  /** disappearing-timer seconds observed on the inbound message, if any */
  ephemeralExpiration?: number
  /** unix seconds when WhatsApp sent it (messageTimestamp) */
  sentAt?: number
  media?: { buffer: Buffer; mime: string; filename?: string }
  mediaError?: "too-large" | "download-failed"
}

export type StatusListener = (status: ConnectionStatus, qr?: string) => void
const MAX_MEDIA_BYTES = 25 * 1024 * 1024
/** Backfill horizon: history messages older than this are never (re)processed */
const BACKFILL_WINDOW_S = 5 * 60
/** A half-dead socket must never stall the chat queue behind a send. */
const SEND_TIMEOUT_MS = 20_000
const PRESENCE_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 60_000

/** Race any socket/media await against a deadline so nothing waits forever. */
async function withTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class WhatsAppClient {
  private socket: ReturnType<typeof makeWASocket> | undefined
  private status: ConnectionStatus = "connecting"
  statusListener: StatusListener | undefined
  messageListener: ((event: MessageEvent) => Promise<void> | void) | undefined
  private stopping = false
  private recentOutgoing = new Set<string>()
  /** message ids already delivered (live or backfill) — stops double-processing across reconnects */
  private seenIds = new Map<string, number>()
  /** per-chat disappearing timer (seconds) last observed on inbound — mirrored on replies */
  private chatEphemeral = new Map<string, number>()

  constructor(
    private readonly config: WacConfig,
    private readonly authDir: string,
  ) {}

  get statusText(): string {
    return this.status
  }

  async start() {
    await this.connect()
  }

  private async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
    const { pino } = await import("pino")
    this.socket = makeWASocket({
      auth: state,
      browser: ["wac", "Chrome", "22"],
      markOnlineOnConnect: false,
      logger: pino({ level: "warn" }) as never,
    })

    this.socket.ev.on("creds.update", saveCreds)

    this.socket.ev.on("connection.update", (update: Partial<ConnectionState>) => this.onConnectionUpdate(update))
    this.socket.ev.on("messages.upsert", (upsert) => this.onMessagesUpsert(upsert))
  }

  private onConnectionUpdate(update: Partial<ConnectionState>) {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      this.status = "qr"
      this.statusListener?.(this.status, qr)
      // Never print pairing QR into daemon logs (launchd captures stdout):
      // only render on an interactive TTY like `wac qr`.
      if (process.stdout.isTTY) {
        QRCode.generate(qr, { small: true }, (code: string) => process.stdout.write(`${code}\n`))
      } else {
        console.log("WhatsApp: needs QR — run `wac qr` on a terminal to link (QR redacted from logs)")
      }
    }

    if (connection === "close") {
      this.status = "close"
      this.statusListener?.(this.status)
      const statusCode = (
        lastDisconnect?.error as unknown as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode
      const isLoggedOut = statusCode === DisconnectReason.loggedOut
      const isTerminal = isLoggedOut || statusCode === DisconnectReason.connectionReplaced || statusCode === 403
      const reasonName = statusCode !== undefined ? (DisconnectReason[statusCode] as string | undefined) : undefined
      console.log(`WhatsApp: close (code ${statusCode ?? "?"}${reasonName ? ` ${reasonName}` : ""})`)
      if (!this.stopping && !isTerminal) {
        const delay = statusCode === DisconnectReason.restartRequired ? 200 : statusCode === DisconnectReason.connectionClosed ? 1000 : 5000
        setTimeout(() => {
          void this.connect()
        }, delay)
      } else if (!this.stopping) {
        this.status = "close"
        this.statusListener?.(this.status)
        process.exit(1)
      }
    }

    if (connection === "open") {
      this.status = "open"
      this.statusListener?.(this.status)
    }
  }

  private async onMessagesUpsert(upsert: { messages: WAMessage[]; type: string }) {
    // "notify" = live delivery. Anything else (history sync after a
    // reconnect) used to be dropped — which silently ate texts sent
    // while the socket was down. Now: recover recent ones, skip the old.
    const fromHistory = upsert.type !== "notify"
    // Extract concurrently so one 25MB download doesn't stall other chats;
    // per-chat ordering is still enforced downstream by the enqueue queue.
    const events = await Promise.all(upsert.messages.map((msg) => this.extractMessage(msg, fromHistory)))
    for (const event of events) {
      if (!event) continue
      if (event.fromMe && this.recentOutgoing.has(event.messageId)) {
        this.recentOutgoing.delete(event.messageId)
        continue
      }
      void this.messageListener?.(event)
    }
  }

  private unwrap(content: NonNullable<WAMessage["message"]>): NonNullable<WAMessage["message"]> {
    if (!content) return content
    const any = content as Record<string, unknown>
    if (any["ephemeralMessage"] && typeof any["ephemeralMessage"] === "object") {
      const inner = (any["ephemeralMessage"] as { message?: NonNullable<WAMessage["message"]> }).message
      if (inner) return this.unwrap(inner)
    }
    if (any["viewOnceMessage"] && typeof any["viewOnceMessage"] === "object") {
      const inner = (any["viewOnceMessage"] as { message?: NonNullable<WAMessage["message"]> }).message
      if (inner) return this.unwrap(inner)
    }
    if (any["viewOnceMessageV2"] && typeof any["viewOnceMessageV2"] === "object") {
      const inner = (any["viewOnceMessageV2"] as { message?: NonNullable<WAMessage["message"]> }).message
      if (inner) return this.unwrap(inner)
    }
    if (any["documentWithCaptionMessage"] && typeof any["documentWithCaptionMessage"] === "object") {
      const inner = (any["documentWithCaptionMessage"] as { message?: NonNullable<WAMessage["message"]> }).message
      if (inner) return this.unwrap(inner)
    }
    return content
  }

  private parseExpiration(value: unknown): number | undefined {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN
    if (!Number.isFinite(n) || n <= 0 || n > 7776000) return undefined
    return Math.floor(n)
  }

  private contextExpiration(content: Record<string, any>): number | undefined {
    const candidates = [
      content?.extendedTextMessage?.contextInfo?.expiration,
      content?.imageMessage?.contextInfo?.expiration,
      content?.videoMessage?.contextInfo?.expiration,
      content?.documentMessage?.contextInfo?.expiration,
      content?.audioMessage?.contextInfo?.expiration,
      content?.stickerMessage?.contextInfo?.expiration,
      content?.messageContextInfo?.expiration,
    ]
    for (const c of candidates) {
      const parsed = this.parseExpiration(c)
      if (parsed) return parsed
    }
    return undefined
  }

  /** Disappearing-timer seconds on an inbound message, if any. Wrapper presence alone implies ephemeral. */
  private inboundEphemeralExpiration(raw: NonNullable<WAMessage["message"]>): number | undefined {
    const anyRaw = raw as unknown as Record<string, any>
    const epi = anyRaw["ephemeralMessage"]
    if (epi && typeof epi === "object") {
      const inner = (epi as { message?: Record<string, any> }).message
      if (inner && typeof inner === "object") {
        const fromInner = this.contextExpiration(inner)
        if (fromInner) return fromInner
      }
      const wrapperExp =
        (epi as { messageContextInfo?: { expiration?: unknown } }).messageContextInfo?.expiration ??
        (epi as { expiration?: unknown }).expiration
      return this.parseExpiration(wrapperExp) ?? 7 * 24 * 60 * 60
    }
    return this.contextExpiration(anyRaw)
  }

  private async extractMessage(message: WAMessage, fromHistory = false): Promise<MessageEvent | undefined> {
    const raw = message.message
    if (!raw) return undefined
    const ephemeralExpiration = this.inboundEphemeralExpiration(raw)
    const content = this.unwrap(raw)
    const text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ??
      ""

    // detect media
    const hasMedia =
      !!content.imageMessage ||
      !!content.videoMessage ||
      !!content.documentMessage ||
      !!content.audioMessage ||
      !!content.stickerMessage

    if (!text.trim() && !hasMedia) return undefined

    const chatJid = message.key.remoteJid ?? ""
    if (!chatJid) return undefined
    if (chatJid.endsWith("@broadcast") || chatJid.endsWith("@newsletter")) return undefined // stories/broadcasts/channels: never process
    // Mirror disappearing timers: remember the last observed setting per chat
    // (self-chat fromMe included — that's where the user's timer lives).
    // Non-ephemeral inbound clears it so turning the timer off sticks.
    if (ephemeralExpiration) this.chatEphemeral.set(chatJid, ephemeralExpiration)
    else this.chatEphemeral.delete(chatJid)
    const isGroup = chatJid.endsWith("@g.us")
    const fromMe = message.key.fromMe === true
    const messageId = message.key.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    if (this.seenIds.has(messageId)) return undefined // redelivered across reconnect — already handled
    this.seenIds.set(messageId, Date.now())
    if (this.seenIds.size > 2000) {
      // bounded memory: drop oldest quarter (window is minutes anyway)
      const sorted = [...this.seenIds.entries()].sort((a, b) => a[1] - b[1])
      for (const [id] of sorted.slice(0, 500)) this.seenIds.delete(id)
    }
    if (fromHistory) {
      if (message.key.fromMe === true) return undefined // our own history — never reprocess
      const ts = Number(message.messageTimestamp ?? 0)
      if (!ts || Date.now() / 1000 - ts > BACKFILL_WINDOW_S) return undefined // older than the outage — ignore
    }
    const senderJid = fromMe ? chatJid : (message.key.participant || chatJid)
    const sentAt = Number(message.messageTimestamp ?? 0) || undefined

    let media: { buffer: Buffer; mime: string; filename?: string } | undefined
    let mediaError: MessageEvent["mediaError"]
    if (hasMedia) {
      try {
        const buffer = (await withTimeout("media download", MEDIA_TIMEOUT_MS, () =>
          downloadMediaMessage(message, "buffer", {} as never, undefined as never),
        )) as Buffer
        if (buffer && buffer.length && buffer.length <= MAX_MEDIA_BYTES) {
          const mime =
            content.imageMessage?.mimetype ??
            content.videoMessage?.mimetype ??
            content.documentMessage?.mimetype ??
            content.audioMessage?.mimetype ??
            content.stickerMessage?.mimetype ??
            "application/octet-stream"
          const filename =
            content.documentMessage?.fileName ??
            (content.imageMessage ? `image-${Date.now()}.jpg` : undefined) ??
            (content.videoMessage ? `video-${Date.now()}.mp4` : undefined)
          media = { buffer, mime: mime.slice(0, 100), filename: filename?.slice(0, 255) }
        } else if (buffer && buffer.length > MAX_MEDIA_BYTES) {
          mediaError = "too-large"
        } else {
          mediaError = "download-failed"
        }
      } catch {
        // download failed — still forward text if any, else report the failure
        mediaError = "download-failed"
      }
    }

    // quoted reply? Baileys nests the original under contextInfo.quotedMessage
    // on whichever wrapper carried the new message (text or captioned media).
    const quotedRaw = this.unwrapQuoted(
      content.extendedTextMessage?.contextInfo?.quotedMessage ??
      content.imageMessage?.contextInfo?.quotedMessage ??
      content.videoMessage?.contextInfo?.quotedMessage ??
      content.documentMessage?.contextInfo?.quotedMessage,
    )
    const quoted = quotedRaw.slice(0, 1000) || undefined

    // if no text and media failed, report the failure instead of silent drop
    if (!text.trim() && !media && !quoted) {
      if (mediaError) return { messageId, chatJid, senderJid, text, quoted, isGroup, fromMe, fromHistory: fromHistory || undefined, ephemeralExpiration, sentAt, mediaError }
      return undefined
    }

    return { messageId, chatJid, senderJid, text, quoted, isGroup, fromMe, fromHistory: fromHistory || undefined, ephemeralExpiration, sentAt, media, mediaError }
  }

  /** Pull readable text out of a quotedMessage payload (already unwrapped shape). */
  private unwrapQuoted(quoted: unknown): string {
    if (!quoted || typeof quoted !== "object") return ""
    const q = this.unwrap(quoted as NonNullable<WAMessage["message"]>)
    const text =
      (q as { conversation?: string }).conversation ??
      (q as { extendedTextMessage?: { text?: string } }).extendedTextMessage?.text ??
      (q as { imageMessage?: { caption?: string } }).imageMessage?.caption ??
      (q as { videoMessage?: { caption?: string } }).videoMessage?.caption ??
      (q as { documentMessage?: { caption?: string } }).documentMessage?.caption ??
      ""
    return text.trim()
  }

  async isAllowed(senderJid: string): Promise<boolean> {
    if (!senderJid) return false
    if (senderJid.endsWith("@g.us") || senderJid.endsWith("@newsletter") || senderJid.endsWith("@broadcast")) return false
    return this.config.allowlist.length > 0 && (await this.normalizeJid(senderJid))
  }

  /** Device-identity self check: does this chat belong to our own account?
   *  Stricter than the allowlist (which can misresolve via LID mapping).
   *  fromMe messages are only processed in true self-chat. */
  selfIds(): string[] {
    const u = this.socket?.user as { id?: string; lid?: string } | undefined
    const out: string[] = []
    if (u?.id) out.push(u.id)
    if (u?.lid && !out.includes(u.lid)) out.push(u.lid)
    return out
  }

  async isSelfChat(chatJid: string): Promise<boolean> {
    if (!chatJid) return false
    const bare = (j: string) => j.split("@")[0].split("$")[0].split(":")[0].replace(/\D/g, "")
    const bareChat = bare(chatJid)
    const self = this.selfIds()
    if (self.length === 0) return this.isAllowed(chatJid) // not connected yet — fall back
    for (const s of self) {
      if (s === chatJid || bare(s) === bareChat) return true
    }
    // LID<->PN alias: resolve both directions before giving up
    try {
      const resolved = await this.resolveLid(chatJid)
      for (const s of self) {
        if (s === resolved || bare(s) === bare(resolved)) return true
      }
    } catch {
      /* ignore */
    }
    return false
  }

  private async resolveLid(jid: string): Promise<string> {
    if (!jid.endsWith("@lid")) return jid
    const lid = jid.split("@")[0]
    try {
      const pn = await this.socket?.signalRepository.lidMapping.getPNForLID(lid)
      if (pn) return `${pn}@s.whatsapp.net`
    } catch {
      /* no reverse mapping known */
    }
    try {
      const { readFileSync } = await import("node:fs")
      const { join } = await import("node:path")
      const reverse = join(this.authDir, `lid-mapping-${lid}_reverse.json`)
      const pn = JSON.parse(readFileSync(reverse, "utf8")) as string
      if (pn) return `${pn}@s.whatsapp.net`
    } catch {
      /* no reverse mapping file */
    }
    return jid
  }

  private async normalizeJid(jid: string): Promise<boolean> {
    const sanitize = (s: string) => s.split("@")[0].split(":")[0].replace(/\D/g, "")
    const resolved = await this.resolveLid(jid)
    const bare = sanitize(resolved)
    for (const entry of this.config.allowlist) {
      const norm = sanitize(entry)
      if (entry === resolved || (norm && norm === bare)) return true
    }
    if (jid.endsWith("@lid")) {
      const lid = jid.split("@")[0]
      for (const entry of this.config.allowlist) {
        const norm = sanitize(entry)
        try {
          const entryLid = await this.socket?.signalRepository.lidMapping.getLIDForPN(norm)
          if (entryLid === lid) return true
        } catch {
          /* ignore */
        }
        try {
          const { readFileSync } = await import("node:fs")
          const { join } = await import("node:path")
          const fwd = join(this.authDir, `lid-mapping-${norm}.json`)
          const fileLid = JSON.parse(readFileSync(fwd, "utf8")) as string
          if (fileLid === lid) return true
        } catch {
          /* ignore */
        }
      }
    }
    return false
  }

  async startTyping(chatJid: string) {
    try {
      if (!this.socket) return
      await withTimeout("presence", PRESENCE_TIMEOUT_MS, () => this.socket!.sendPresenceUpdate("composing", chatJid))
    } catch {
      /* best effort */
    }
  }

  async stopTyping(chatJid: string) {
    try {
      if (!this.socket) return
      await withTimeout("presence", PRESENCE_TIMEOUT_MS, () => this.socket!.sendPresenceUpdate("paused", chatJid))
    } catch {
      /* best effort */
    }
  }

  async sendText(chatJid: string, text: string, opts?: { ephemeralExpiration?: number }): Promise<void> {
    if (!text.trim()) return
    if (!this.socket) throw new Error("WhatsApp socket not connected")
    // linkPreview: null disables baileys' auto-fetch-on-send (link-preview-js has an
    // unpatched SSRF via DNS rebinding - GHSA-4gp8-rjrq-ch6q / GHSA-cpjf-6666-r8fx).
    const content: AnyMessageContent = { text, linkPreview: null }
    // Mirror the chat's disappearing timer when known, so replies vanish on
    // the same schedule as the user's messages. Newsletters can't be ephemeral
    // (Baileys drops the flag there); groups never reach this path.
    const ephemeralExpiration = opts?.ephemeralExpiration ?? this.chatEphemeral.get(chatJid)
    const result = await withTimeout("whatsapp send", SEND_TIMEOUT_MS, () =>
      ephemeralExpiration
        ? this.socket!.sendMessage(chatJid, content, { ephemeralExpiration })
        : this.socket!.sendMessage(chatJid, content),
    )
    const id = result?.key?.id
    if (id) {
      this.recentOutgoing.add(id)
      setTimeout(() => this.recentOutgoing.delete(id), 30_000)
    }
  }

  async sendImage(chatJid: string, filePath: string, caption?: string, opts?: { ephemeralExpiration?: number }): Promise<void> {
    if (!this.socket) throw new Error("WhatsApp socket not connected")
    const image = await readFile(filePath)
    const content: AnyMessageContent = caption?.trim() ? { image, caption: caption.trim() } : { image }
    const ephemeralExpiration = opts?.ephemeralExpiration ?? this.chatEphemeral.get(chatJid)
    const result = await withTimeout("whatsapp send", SEND_TIMEOUT_MS, () =>
      ephemeralExpiration
        ? this.socket!.sendMessage(chatJid, content, { ephemeralExpiration })
        : this.socket!.sendMessage(chatJid, content),
    )
    const id = result?.key?.id
    if (id) {
      this.recentOutgoing.add(id)
      setTimeout(() => this.recentOutgoing.delete(id), 30_000)
    }
  }

  async shutdown() {
    this.stopping = true
    try {
      await withTimeout("whatsapp shutdown", 2_000, async () => {
        await this.socket?.end(new Error("wac stopping"))
      })
    } catch {
      /* a dead socket must not block process shutdown */
    }
  }
}

export async function hasCredentials(authDir: string): Promise<boolean> {
  try {
    const files = await import("node:fs/promises").then((fs) => fs.readdir(authDir))
    return files.includes("creds.json")
  } catch {
    return false
  }
}
