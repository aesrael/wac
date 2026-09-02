import makeWASocket, {
  DisconnectReason,
  type AnyMessageContent,
  type ConnectionState,
  type WAMessage,
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
}

export type StatusListener = (status: ConnectionStatus, qr?: string) => void

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
      QRCode.generate(qr, { small: true }, (code: string) => process.stdout.write(`${code}\n`))
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

  private onMessagesUpsert(upsert: { messages: WAMessage[] }) {
    for (const msg of upsert.messages) {
      const event = this.extractMessage(msg)
      if (!event) continue
      if (event.fromMe && this.recentOutgoing.has(event.messageId)) {
        this.recentOutgoing.delete(event.messageId)
        continue
      }
      void this.messageListener?.(event)
    }
  }

  private extractMessage(message: WAMessage): MessageEvent | undefined {
    const content = message.message
    if (!content) return undefined
    const text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      ""
    if (!text.trim()) return undefined

    const chatJid = message.key.remoteJid ?? ""
    if (!chatJid) return undefined
    const isGroup = chatJid.endsWith("@g.us")
    const fromMe = message.key.fromMe === true
    const messageId = message.key.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const senderJid = fromMe ? chatJid : (message.key.participant ?? chatJid)

    return { messageId, chatJid, senderJid, text, isGroup, fromMe }
  }

  async isAllowed(senderJid: string): Promise<boolean> {
    if (!senderJid) return false
    if (senderJid.endsWith("@g.us") || senderJid.endsWith("@newsletter") || senderJid.endsWith("@broadcast")) return false
    return this.config.allowlist.length > 0 && (await this.normalizeJid(senderJid))
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
    const resolved = await this.resolveLid(jid)
    const bare = resolved.split("@")[0]
    for (const entry of this.config.allowlist) {
      const norm = entry.split("@")[0]
      if (entry === resolved || norm === bare) return true
    }
    if (jid.endsWith("@lid")) {
      const lid = jid.split("@")[0]
      for (const entry of this.config.allowlist) {
        const norm = entry.split("@")[0]
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

  async sendImage(chatJid: string, buffer: Buffer, caption?: string): Promise<void> {
    const content: AnyMessageContent = { image: buffer, caption }
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