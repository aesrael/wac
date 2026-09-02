# wac

WhatsApp → opencode bridge. Message your opencode agent from WhatsApp, with
persistent sessions, session browsing/switching, and slash-command passthrough.

## Goal

A single-user background daemon that:

1. Listens on WhatsApp (Baileys, QR-based linked device — the same mechanism
   OpenClaw's WhatsApp channel used).
2. Maps each WhatsApp chat to a persistent opencode session (via `opencode
   serve`'s HTTP/WS API + `@opencode-ai/sdk`).
3. Streams opencode replies back into WhatsApp, chunked to platform limits.
4. Supports browsing/checking out sessions and slash commands the way you get
   them in the opencode TUI/web client — simplified for WhatsApp.

It is intentionally *not* a multi-platform ACP bridge (e.g. `opencode-chat-bridge`).
This is WhatsApp-only, direct-to-opencode-server, owned and lean.

## Architecture

```
WhatsApp (Baileys socket)  ──  wac daemon (Node)  ──  opencode serve (Socket.IO/HTTP API)
      │  QR login / keepalive       │  session routing / chunking        │ prompt → stream
      ▼                             ▼
   whatsapp clients           session store (chat id → opencode session id)
```

- `wac serve` — run the daemon (listens on WhatsApp).
- `wac qr` / `wac login` — trigger/display QR pairing.
- `wac status` — connection + session summary (see `wac status` contract below).
- `opencode serve` runs alongside (its own process); wac connects to it.

### Runtime rationale

**Node**, not Rust: both hard dependencies are JS-native — Baileys (WhatsApp)
and `@opencode-ai/sdk`. Rust would need an embedded JS runtime to reach them,
for a daemon whose memory/battery footprint is negligible. Launchd restarts
either way. Revisit only if a single self-contained binary becomes a goal.

### Paths & config layout

Everything under `~/.config/wac/` (project-local files are templates only):

- `~/.config/wac/config.json` — operator settings (auto-created on first run):
  `allowlist` (WhatsApp numbers, fail-closed — must be non-empty), `opencodeBaseUrl`
  (default `http://127.0.0.1:8080`), `opencodeUsername` (default `opencode`),
  `opencodePassword`, `name` (WhatsApp display name). See `config.example.json`.
- `~/.config/wac/store.json` — session store (chat jid → opencode session id +
  per-chat model). Shape documented in `wac.example.json`.
- `~/.config/wac/auth/` — Baileys creds (same layout as Baileys
  `useMultiFileAuthState`, gitignored by convention).

### Auth (password to opencode serve)

Loopback-only bind handles remote attackers; the password protects against *local*
processes running as your user (browser tabs, scripts, malware with your perms)
reaching the full opencode API — which executes bash. **Required**: set
`OPENCODE_SERVER_PASSWORD` (Basic auth; username via `OPENCODE_SERVER_USERNAME`,
default `opencode`) on the `opencode serve` process; wac sends the same
`username:password` as a Basic `Authorization` header via the SDK's config.
No credential minting/rotation in wac — it's just config passthrough.

### `wac status` contract

Prints one line per signal, exits nonzero if opencode unreadable:

- WhatsApp: connected / disconnected (reconnecting) / needs QR re-link
- opencode serve: reachable / down (retrying)
- session count + the active chat→session mapping summary

## Non-negotiables

- **Direct to opencode server API.** Use `@opencode-ai/sdk` (or its HTTP/Socket.IO
  surface) to create/send/list sessions. Do NOT introduce ACP as a translation
  layer, or spawn a per-message CLI subprocess.
- **One opencode session per WhatsApp chat.** Persisted across daemon restarts
  (JSON store: chat id -> opencode session id). Session state survives.
- **Slash commands pass through to opencode.** Anything opencode serves natively
  (user-defined commands like `/init`, `/review` via `/session/{id}/command`)
  is passed straight through; anything wac handles locally is resolved against
  the server API. **wac-local** (resolved here against opencode's HTTP API, not
  the CLI): `/sessions` (server session list), `/session <id>` (remap chat),
  `/new` and `/clear` (create fresh session + remap), `/model <provider/model>`
  (per-chat model passed on each prompt), `/compact` (server summarize), and
  local-only `/status`, `/help`. Unknown `/foo` first tries the server command
  endpoint; on 400 it is reported to the user rather than sent to the model.
- **Chunking.** Split long replies at 4000 chars (below WhatsApp's ~4096 cap,
  room for a `(n/m)` suffix). Prefer paragraph, then line, then sentence, then
  space; never split mid-fence or inside an unbalanced backtick run; hard split
  only as a last resort when a single block exceeds the cap. One DM per chunk,
  ordered.
- **Security posture (single user).** DM allowlist of your number only.
  Groups ignored unless explicitly opted in. Loopback-only bind to `opencode
  serve`, plus basic-auth password (see above). Never log or persist
  the session creds/API keys in plaintext beyond what opencode already
  requires.
- **Resilience.** Reconnect on WhatsApp socket drop (Baileys), re-link QR if
  session invalid. Crash → restart under launchd. Tolerate `opencode serve`
  being down and retry rather than swallow errors.
- **Silent by default.** No history exfiltration: only chats you DM the bot are
  sent to opencode. Read-receipts/settings conservative.

## Scope for v1 (ship list)

- `wac serve` + QR pairing + keepalive/reconnect
- DM chat → persistent session mapping (one per chat)
- `/sessions` list; `/session <id>` checkout; `/new`; `/clear`; `/model <x>`
  (all wac-local, resolved against the server API — opencode has no native
  equivalents for these)
- opencode slash-command passthrough (`/init`, `/review`, and any user-defined
  commands opencode serves via `/session/{id}/command`)
- Streaming reply → WhatsApp chunks
- launchd plist (auto-start, crash-restart) + `wac status`
- `opencode.json` permission defaults (single-user, allow read/write/bash but
  deny nothing the user needs; keep it usable, not a locked-down bot)

## Explicitly NOT v1

- Groups / multi-account / multi-user
- Permissions-for-others (this is a personal assistant)
- Voice/media-heavy flows (text-first; images later if trivial)
- ACP / multi-agent backend abstraction
- Web/Telegram/Discord connectors

## Reference

Proof it works elsewhere (patterns to borrow, NOT to fork):
- `ominiverdi/opencode-chat-bridge` — Baileys QR store, per-thread session
  persistence, `/s` `/p` session-picker commands, chunk splitting, restart
  resume, execution-level permission model. Its README/docs detail each.
- opencode SDK / server docs — `opencode serve`, `@opencode-ai/sdk`,
  Socket.IO event surface (session.created/updated, message parts, idle).
- OpenClaw's purged WhatsApp extension (Baileys 7, QR pairing) — mechanism
  you reused.

## Agent instructions

When working in this repo:

- Node 22 + TypeScript (Bun optional; keep dependencies minimal).
- Structure: `wac/` entry + `src/` (baileys.ts, sessions.ts, serve-client.ts,
  chunker.ts, store.ts, commands.ts), `opencode.json`, `config.example.json`,
  `wac.example.json` (chat→session store schema), launchd plist template.
- Verify: `npm run build && node wac serve` connects, QR links, a DM
  round-trips a reply, and `/sessions`/`/session` behave. Document failure
  modes in README.
- Keep it terse, self-owned, no over-engineering — a personal tool like
  `glance` / `terminus`, not a framework.