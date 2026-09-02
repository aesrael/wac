# wac — WhatsApp ↔ opencode bridge

Talk to your [opencode](https://opencode.ai) agent from WhatsApp. DMs map to
persistent opencode sessions — leave the chat, come back days later, context
is still there. Send a slash command to browse/switch sessions or set the model.

Single-user by design: a DM allowlist (fail-closed), groups ignored, and a
password-protected loopback `opencode serve`. No cloud, no database — just
`~/.config/wac/` (config + session-store JSON + Baileys auth dir).

## How it works

```
┌──────────┐  Baileys/QR   ┌──────────────────┐  HTTP BasicAuth  ┌─────────────────┐
│ WhatsApp │ ───────────► │ wac (Node)       │ ───────────────► │ opencode serve  │
│  phone   │               │  chat→session    │                  │  @opencode-ai/sdk│
└──────────┘               │  chunk 4k (n/m)  │                  └────────┬────────┘
                           │  /help /model/*  │                           │ sessions
                           └────────┬─────────┘                           │
                                    │ store.json                          │
                           ┌────────▼────────┐                             │
                           │ ~/.config/wac/  │ ◄───────────────────────────┘
                           │  config.json    │
                           │  store.json     │
                           │  auth/ (Baileys)│
                           └─────────────────┘
```

- **One WhatsApp chat ↔ one opencode session.** The mapping persists in
  `store.json`, so conversations survive daemon restarts, reconnects, and
  your phone being offline. If opencode loses a session (restart), wac
  recreates it transparently.
- **Replies preserve WhatsApp formatting.** `*bold*`, `` `code` ``, ```blocks```,
  `> quotes`, `•` lists stay; `#` headings become `*bold*`, `[text](url)` becomes
  `text https://url`. Long replies are split at 4000 chars (`(n/m)` suffix),
  never mid-fence.
- **Welcome DM.** When wac connects, it sends an "online" message to each
  allowlisted number so you know it's live.
- **Slash commands** are resolved against the opencode HTTP API — no CLI
  subprocess, no ACP.

## Prerequisites

- Node 22+
- [opencode](https://opencode.ai) installed (`~/.opencode/bin/opencode`)
- A WhatsApp account (the phone number the bot will be a linked device to)

## Setup

1. **Install & build**

   ```sh
   npm install && npm run build
   ```

2. **Configure wac.** First run creates `~/.config/wac/config.json` from
   `config.example.json`. Edit it:

   ```json
   {
     "allowlist": ["12025550123"],
     "opencodeBaseUrl": "http://127.0.0.1:8080",
     "opencodeUsername": "opencode",
     "name": "wac",
     "opencodeDirectory": "/Users/you/Desktop",
     "defaultModel": "opencode/big-pickle"
   }
   ```

   - `allowlist` — your WhatsApp number(s), E.164 (`4479...`), fail-closed.
   - `opencodePassword` — optional; if omitted, set `OPENCODE_SERVER_PASSWORD`
     env on the wac process instead. wac also reads it from `config.json` and
     passes it to `opencode serve` if it needs to spawn it.
   - `opencodeDirectory` — project root opencode runs in.
   - `defaultModel` — optional `provider/model` used when a chat has no per-chat
     `/model` set.

3. **Run & link**

   ```sh
   node wac serve
   ```

   A QR code prints to the terminal — scan it with WhatsApp → Settings →
   Linked devices. Credentials are saved in `~/.config/wac/auth/` and the link
   resumes automatically on future restarts. If `opencode serve` is not
   reachable at `opencodeBaseUrl`, wac spawns it for you on the configured
   port (loopback-only).

4. **(Optional) Always-on.** Install the launchd plist so wac starts at login
   and restarts on crash:

   ```sh
   npm run launchd
   ```

   This reads your password and port from `~/.config/wac/config.json` and
   generates `~/Library/LaunchAgents/com.user.wac.plist` automatically.
   Re-run after config changes to update it.

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
| `/models [n]` | list available models (default 20, max 100) |
| `/compact` | summarize/compact the current session |
| `/status` | connection + auth status |
| `/help` | this list |
| `/anything-else` | passed through to opencode's command endpoint (`/init`, `/review`, user-defined) — unknown commands are reported, never sent to the model |
| plain text | sent as a prompt to this chat's session (with a WhatsApp-tuned system prompt) |

## Status

```sh
node wac status
node wac qr      # show pairing QR and exit once linked
node wac serve   # start daemon
```

`wac status` prints WhatsApp link state, opencode reachability, and the
session→chat mapping. Exits nonzero if `opencode serve` is unreachable.

## Failure modes

| Symptom | Cause | Behavior |
| --- | --- | --- |
| QR shown on every start | `auth/creds.json` missing or link revoked | Re-scan once; creds then persist |
| `WhatsApp: close` in log | Baileys socket dropped | Auto-reconnect (fast for WA's restart-required handshake, ~5s for drops); logout/forbidden exits (launchd restarts) |
| `(error) ...` on prompt | `opencode serve` down | Session mapping survives; wac auto-spawns serve if needed and retries on next message; `wac status` exits nonzero |
| `Session not found` | opencode restarted and lost sessions | wac detects missing server session and creates a fresh one for the chat |
| `/foo` "opencode rejected command" | not a real command | Reported to you, not sent to the model |
| `/compact` error about model | no per-chat model set | `/model <provider/model>` first (or set `defaultModel` in config) |
| long replies | normal | chunked with `(n/m)` suffixes, never split inside ```fence``` |

Known limits: text-only (no media/files), no groups, replies arrive when the
agent finishes (no word-by-word streaming).

Not v1: groups, multi-account, media, ACP, other platforms (Telegram/Discord/web).

## License

MIT (c) 2026 — see [LICENSE](LICENSE).
