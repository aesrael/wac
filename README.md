# wac — WhatsApp ↔ opencode

Chat with your [opencode](https://opencode.ai) agent from WhatsApp.

- One DM = one persistent session. Close the chat, come back days later — context is still there.
- Single-user, fail-closed. Allowlisted DMs only, groups ignored.
- No cloud, no DB. Just `~/.config/wac/` (config, session store, Baileys auth).

## How it works

```
┌──────────┐  Baileys/QR   ┌──────────────────┐  HTTP  ┌─────────────────┐
│ WhatsApp │ ───────────► │ wac (Node)       │ ─────► │ opencode serve  │
│  phone   │               │  chat→session    │        │  @opencode-ai/sdk│
└──────────┘               │  chunk 4k (n/m)  │        └────────┬────────┘
                           └────────┬─────────┘                 │
                                    │ store.json                │
                           ┌────────▼────────┐                   │
                           │ ~/.config/wac/  │ ◄─────────────────┘
                           │  config.json    │
                           │  store.json     │
                           │  auth/          │
                           └─────────────────┘
```

- **Session per chat.** Mapping in `store.json` survives restarts. If opencode loses a session, wac recreates it.
- **WhatsApp formatting kept.** `*bold*`, `` `code` ``, ```blocks```, `> quote`, `•` lists. `#` → `*bold*`, `[text](url)` → `text https://url`.
- **Chunked.** Split at 4000 chars, `(n/m)` suffix, never mid-```fence```.
- **Welcome DM** on connect so you know it's live.

## Quick start

**Prereqs:** Node 22+, `opencode` installed, WhatsApp account.

```sh
npm install && npm run build
# edit ~/.config/wac/config.json (created from config.example.json)
node wac serve   # scan QR → WhatsApp > Linked devices
```

Config (`~/.config/wac/config.json`):

```json
{
  "allowlist": ["447900000000"],
  "opencodeBaseUrl": "http://127.0.0.1:8080",
  "name": "wac",
  "opencodeDirectory": "/Users/you/Desktop",
  "defaultModel": "opencode/big-pickle"
}
```

- `allowlist` — E.164 numbers, fail-closed.
- `opencodePassword` — or `OPENCODE_SERVER_PASSWORD` env. Wac passes it to `opencode serve` if it spawns it.
- Wac auto-spawns `opencode serve` if not reachable.

**Always-on (optional):**

```sh
npm run launchd   # generates ~/Library/LaunchAgents/com.user.wac.plist from config.json
```

## Commands

DM the bot:

| Command | What it does |
| --- | --- |
| `/help` | this list |
| `/status` | WhatsApp + opencode status |
| `/sessions` | list sessions + chat mapping |
| `/session <id>` | switch this chat to another session |
| `/new` `/clear` | fresh session for this chat |
| `/current` | current session (+ model) |
| `/delete` | delete current session |
| `/model` | show chat's model |
| `/model <p/m>` | set model for this chat |
| `/models [n]` | list models (20 default, 100 max) |
| `/compact` | summarize session |
| plain text | prompt for this chat's session |

`/anything-else` → opencode command (`/init`, etc.). Unknown commands are reported, not sent to model.

## Status

```sh
node wac status   # WhatsApp + opencode + mapping, exits 1 if opencode down
node wac qr       # show QR and exit once linked
node wac serve    # start daemon
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| QR every start | `auth/creds.json` missing — re-scan once |
| `WhatsApp: close` | auto-reconnects (5s); logout exits — launchd restarts |
| `(error)` on prompt | `opencode serve` down — wac auto-spawns, retry next message |
| `Session not found` | opencode restarted — wac creates fresh session |
| `/compact` needs model | `/model <provider/model>` first or set `defaultModel` |
| Long reply | chunked `(n/m)`, never inside ```fence``` |

Limits: text-only, no groups, no streaming (reply when agent finishes).

## License

MIT (c) 2026 — [LICENSE](LICENSE)
