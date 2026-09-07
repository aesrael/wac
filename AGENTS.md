# wac — agent guardrails

WhatsApp → opencode bridge (single-user daemon). README covers the what/how;
this file is the don'ts. Keep it that way — details live in README, not here.

## Stack

Node 22 + TypeScript. Entry `wac` + `src/` (index, baileys, sessions,
serve-client, chunker, store, commands, config). Verify with `npm run build`.

## Rules

- **Direct to opencode server API** via `@opencode-ai/sdk`. No ACP layer,
  no per-message CLI spawn.
- **One opencode session per chat**, persisted in `store.json`. Never drop
  or orphan mappings; recreate fresh when the server has lost one.
- **Replies are WhatsApp text**, chunked at 4000 chars (`(n/m)` suffix, never
  mid-fence). Inbound media goes to opencode; nothing else changes shape.
- **Silent by default.** Only chats the operator DMs go to opencode. Groups
  ignored. Never read, log, or persist `~/.config/wac/auth/`, live
  `config.json`/`store.json` contents, `~/.config/opencode/auth.json`,
  `*.env`, or server passwords beyond what the code already passes through.
- **Resilient, not clever.** Reconnect WhatsApp drops, re-link QR when
  invalid, tolerate `opencode serve` being down (retry, don't swallow).
  Crash → supervisor restarts; exit nonzero when a restart is requested.
- **Terse, self-owned.** Personal tool, not a framework. No new deps,
  no abstractions ahead of need. Commands table in README is authoritative;
  wac-local ones resolve against the server API, everything else passes
  through to opencode.
