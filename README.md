# wac — WhatsApp ↔ opencode

Chat with your [opencode](https://opencode.ai) agent from WhatsApp.

- One DM = one persistent session. Close the chat, come back days later — context is still there.
- Single-user, fail-closed. Allowlisted DMs only, groups ignored.
- No cloud, no DB. Just `~/.config/wac/` (config, session store, Baileys auth).

## How it works

```
┌──────────┐  Baileys/QR   ┌──────────────────┐  HTTP  ┌─────────────────┐
│ WhatsApp │ ───────────► │ wac (Node)       │ ───────────────► │ opencode serve  │
│  phone   │               │  per-chat queue  │                  │  @opencode-ai/sdk│
└──────────┘               │  chat→session    │                  └────────┬────────┘
                           │  chunk 4k (n/m)  │                           │
                           └────────┬─────────┘                           │
                                    │ store.json                          │
                           ┌────────▼────────┐                             │
                           │ ~/.config/wac/  │ ◄───────────────────────────┘
                           │  config.json    │
                           │  store.json     │
                           │  auth/          │
                           │  outbox/ ◄── external tools drop JSON, sent via live socket
                           └─────────────────┘
```

- **Session per chat.** Mapping in `store.json` survives restarts. If opencode loses a session, wac recreates it.
- **One at a time per chat.** Prompts run serially through a per-chat queue; local commands (`/status`, `/stop`, `/restart`) jump ahead and answer immediately, even during a long prompt.
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
  "allowlist": ["<your-e164-number>"],
  "opencodeBaseUrl": "http://127.0.0.1:8080",
  "name": "wac",
  "opencodeDirectory": "<project-directory>",
  "defaultModel": "opencode/big-pickle"
}
```

- `allowlist` — E.164 numbers, fail-closed.
- `npm run launchd` — installs Wac as a macOS LaunchAgent; the generated plist and logs stay outside Git.
- `opencodePassword` — or `OPENCODE_SERVER_PASSWORD` env. Wac passes it to `opencode serve` if it spawns it.
- Wac auto-spawns `opencode serve` if not reachable.

## Commands

DM the bot:

| Command | What it does |
| --- | --- |
| `/help` | this list |
| `/status` | WhatsApp + opencode status |
| `/sessions` | list sessions + chat mapping |
| `/session <id>` | switch this chat to another session |
| `/session delete [<n>\|all] [confirm]` | delete session(s), same rules as `/delete` |
| `/delete` | delete current session (alias for `/session delete`) |
| `/new` `/clear` | fresh session for this chat |
| `/fork [message-id]` | fork this chat's session at a message point |
| `/current` | current session (+ model) |
| `/delete` | delete current session |
| `/delete all` | delete every session (needs `confirm`) |
| `/model` | show chat's model |
| `/model <p/m>` | set model for this chat |
| `/model default <p/m>` | set global default model (new chats use it) |
| `/models [query] [n]` | search/list models (20 default, 100 max) |
| `/compact` | summarize session |
| `/stop` | cancel running work |
| `/restart` | restart wac daemon (opencode untouched) |
| plain text | prompt for this chat's session |

`/anything-else` → opencode command (`/init`, etc.). Unknown commands are reported, not sent to model.

## Status

```sh
node wac status   # WhatsApp + opencode + mapping, exits 1 if opencode down
node wac qr       # show QR and exit once linked
node wac serve    # start daemon
```

## Outbox

External tools can send WhatsApp through the daemon's own socket — no second
connection. Drop `{ to?, text, created? }` JSON into `~/.config/wac/outbox/`:

```sh
python3 -c "import json,time; json.dump({'text':'hello','created':int(time.time()*1000)}, open('$HOME/.config/wac/outbox/hi.json','w'))"
```

Sent within ~15s, deleted on success, renamed `.dead` after 5 failures. Missing
`to` → first allowlisted number. Files queued >5 min get a staleness prefix.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| QR every start | `auth/creds.json` missing — re-scan once |
| `WhatsApp: close` | auto-reconnects (5s); logout exits — launchd restarts |
| `(error)` on prompt | `opencode serve` down — wac auto-spawns, retry next message |
| `Session not found` | opencode restarted — wac creates fresh session |
| `/compact` needs model | `/model <provider/model>` first or set `defaultModel` |
| `No models match` / `Unknown model` for IDs that CLI lists | `opencode serve` is stale — `/restart` leaves it untouched; kill the `opencode serve` process and restart wac so it spawns a fresh one |
| Long reply | chunked `(n/m)`, never inside ```fence``` |

Limits: replies are text-only; no groups; no streaming (reply when agent finishes). Inbound media (images, video, docs, audio) is forwarded to opencode.

## License

MIT (c) 2026 — [LICENSE](LICENSE)
