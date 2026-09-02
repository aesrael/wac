# wac — WhatsApp ↔ opencode bridge

Talk to your [opencode](https://opencode.ai) agent from WhatsApp. DMs map to
persistent opencode sessions — leave the chat, come back days later, context
is still there. Send a slash command to browse/switch sessions or set the model.

Single-user by design: a DM allowlist (fail-closed), groups ignored, and a
password-protected loopback `opencode serve`. No cloud, no database — just
`~/.config/wac/` (config + session-store JSON + Baileys auth dir).

## How it works

```
phone ── WhatsApp/Baileys ──► wac (Node daemon) ──HTTP──► opencode serve (your machine)
                                   │
                        ~/.config/wac/{config,store}.json + auth/
```

- **One WhatsApp chat ↔ one opencode session.** The mapping persists in
  `store.json`, so conversations survive daemon restarts, reconnects, and
  your phone being offline.
- **Replies are tidied and chunked.** Markdown is lightly normalized (fences
  stripped, headers/bold un-bolded) and long replies are split at 4000 chars
  (`(n/m)` suffix when broken up). Every reply is prefixed with `> ` so it
  reads as a distinct message, not your own typing.
- **Welcome DM.** When wac connects, it sends an "online" message to each
  allowlisted number so you know it's live.
- **Slash commands** are resolved against the opencode HTTP API — no CLI
  subprocess, no ACP.

## Prerequisites

- Node 22+
- [opencode](https://opencode.ai) installed
- A WhatsApp account (the phone number the bot will be a linked device to)

## Setup

1. **Install & build**

   ```sh
   npm install && npm run build
   ```

2. **Start `opencode serve`** on loopback with a password.

   ```sh
   OPENCODE_SERVER_PASSWORD=<your-own-password> opencode serve --hostname 127.0.0.1 --port 8080
   ```

   Keep this terminal/process running. Loopback-only bind + Basic-auth password
   keeps the API (which can run bash) safe from other processes on your machine.

3. **Configure wac.** First run creates `~/.config/wac/config.json` from
   `config.example.json`. Edit it:

   ```json
   {
     "allowlist": ["12025550123"],
     "opencodeBaseUrl": "http://127.0.0.1:8080",
     "opencodeUsername": "opencode",
     "name": "wac"
   }
   ```

   - `allowlist` — your WhatsApp number(s), E.164 (`4479...`), fail-closed.
   - `opencodePassword` — optional; if omitted, set the `OPENCODE_SERVER_PASSWORD`
     environment variable on the wac process instead (same value as step 2).

4. **Run & link**

   ```sh
   node wac serve
   ```

   A QR code prints to the terminal — scan it with WhatsApp → Settings →
   Linked devices. Credentials are saved in `~/.config/wac/auth/` and the link
   resumes automatically on future restarts.

5. **(Optional) Always-on.** Install the launchd plist so wac starts at login
   and restarts on crash:

   ```sh
   cp wac.serve.plist ~/Library/LaunchAgents/com.user.wac.plist
   # edit paths + OPENCODE_SERVER_PASSWORD in the plist and scripts/wac.serve.sh
   launchctl load ~/Library/LaunchAgents/com.user.wac.plist
   ```

## Commands (DM the bot)

| Command | What it does |
| --- | --- |
| `/sessions` | list opencode sessions, which chat maps to each (full IDs) |
| `/session <id>` | point this chat at an existing session (prefix match OK) |
| `/new` `/clear` | start a fresh session for this chat |
| `/current` | show the current session for this chat (+ model if set) |
| `/delete` | delete the current session for this chat (server + mapping) |
| `/model` | show this chat's model (or `(default)` if none set) |
| `/model <provider/model>` | set the model for this chat's prompts |
| `/compact` | summarize/compact the current session |
| `/status` | connection + auth status |
| `/help` | this list |
| `/anything-else` | passed through to opencode's command endpoint (`/init`, `/review`, user-defined) — unknown commands are reported, never sent to the model |
| plain text | sent as a prompt to this chat's session (with a WhatsApp-tuned system prompt) |

## Status

```sh
node wac status
```

Prints WhatsApp link state, opencode reachability, and the session→chat
mapping. Exits nonzero if `opencode serve` is unreachable.

## Failure modes

| Symptom | Cause | Behavior |
| --- | --- | --- |
| QR shown on every start | `auth/creds.json` missing or link revoked | Re-scan once; creds then persist |
| `WhatsApp: close` in log | Baileys socket dropped | Auto-reconnect (fast for WA's restart-required handshake, ~5s for drops); logout/forbidden exits (launchd restarts) |
| `(error) ...` on prompt | `opencode serve` down | Session mapping survives; wac retries on the next message (no queuing); `wac status` exits nonzero |
| `/foo` "opencode rejected command" | not a real command | Reported to you, not sent to the model |
| `/compact` error about model | no per-chat model set | `/model <provider/model>` first |
| long replies | normal | chunked with `(n/m)` suffixes |

Known limits: text-only (no media/files), no groups, replies arrive when the
agent finishes (no word-by-word streaming).

## Commands

```
wac serve   start the daemon
wac qr      show the pairing QR and exit once linked
wac status  connection + session summary
```

## Layout

```
wac                 bin entry (loads dist/index.js)
src/                TypeScript
  index.ts          CLI (serve/qr/status) + message handler
  baileys.ts        WhatsApp socket, QR, reconnect
  serve-client.ts   opencode SDK facade (Basic auth)
  sessions.ts       chat→session routing
  commands.ts       slash-command handling
  chunker.ts        markdown-safe 4000-char splitting
  store.ts          store.json persistence
  config.ts         ~/.config/wac/config.json
opencode.json       permission defaults (single-user, all allowed)
config.example.json template for ~/.config/wac/config.json
wac.example.json    example store.json shape
wac.serve.plist     launchd template
```

Not v1: groups, multi-account, media, ACP, other platforms (Telegram/Discord/web).

## License

MIT (c) 2026 — see [LICENSE](LICENSE).