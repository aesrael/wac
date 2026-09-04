import makeWASocket, {
  DisconnectReason,
  type AnyMessageContent,
  type ConnectionState,
  type WAMessage,
  downloadMediaMessage,
} from "@whiskeysockets/baileys"
import { useMultiFileAuthState } from "@whiskeysockets/baileys"
import QRCode from "qrcode-terminal"
import { WacConfig } from "./config.js"

export type ConnectionStatus = "connecting" | "open" | "close" | "qr"

export type MessageEvent = {
  messageId: string
  chatJid: string
  senderJid: string
  text: string
  isGroup: boolean
  fromMe: boolean
  media?: { buffer: Buffer; mime: string; filename?: string }
  mediaError?: "too-large" | "download-failed"
}

export type StatusListener = (status: ConnectionStatus, qr?: string) => void
const MAX_MEDIA_BYTES = 25 * 1024 * 1024

export class WhatsAppClient {
  private socket: ReturnType<typeof makeWASocket> | undefined
  private status: ConnectionStatus = "connecting"
  statusListener: StatusListener | undefined
  messageListener: ((event: MessageEvent) => Promise<void> | void) | undefined
  private stopping = false
  private recentOutgoing = new Set<string>()

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
      if (!this.stopping && !isTerminal) {
        const delay = statusCode === DisconnectReason.restartRequired ? 200 : statusCode === DisconnectReason.connectionClosed ? 1000 : 5000
        setTimeout(() => {
          void this.connect()
        }, delay)
      } else if (this.stopping) {
        process.exit(0)
      } else {
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
    if (upsert.type !== "notify") return // ignore history backfills/appends
    // Extract concurrently so one 25MB download doesn't stall other chats;
    // per-chat ordering is still enforced downstream by the enqueue queue.
    const events = await Promise.all(upsert.messages.map((msg) => this.extractMessage(msg)))
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

  private async extractMessage(message: WAMessage): Promise<MessageEvent | undefined> {
    const raw = message.message
    if (!raw) return undefined
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
    const isGroup = chatJid.endsWith("@g.us")
    const fromMe = message.key.fromMe === true
    const messageId = message.key.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const senderJid = fromMe ? chatJid : (message.key.participant ?? chatJid)

    let media: { buffer: Buffer; mime: string; filename?: string } | undefined
    let mediaError: MessageEvent["mediaError"]
    if (hasMedia) {
      try {
        const buffer = (await downloadMediaMessage(message, "buffer", {} as never, undefined as never)) as Buffer
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

    // if no text and media failed, report the failure instead of silent drop
    if (!text.trim() && !media) {
      if (mediaError) return { messageId, chatJid, senderJid, text, isGroup, fromMe, mediaError }
      return undefined
    }

    return { messageId, chatJid, senderJid, text, isGroup, fromMe, media, mediaError }
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
      await this.socket?.sendPresenceUpdate("composing", chatJid)
    } catch {
      /* best effort */
    }
  }

  async stopTyping(chatJid: string) {
    try {
      await this.socket?.sendPresenceUpdate("paused", chatJid)
    } catch {
      /* best effort */
    }
  }

  async sendText(chatJid: string, text: string): Promise<void> {
    if (!text.trim()) return
    const content: AnyMessageContent = { text }
    const result = await this.socket?.sendMessage(chatJid, content)
    const id = result?.key?.id
    if (id) {
      this.recentOutgoing.add(id)
      setTimeout(() => this.recentOutgoing.delete(id), 30_000)
    }
  }

  async shutdown() {
    this.stopping = true
    try {
      await this.socket?.end(new Error("wac stopping"))
    } catch {
      /* ignore */
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
