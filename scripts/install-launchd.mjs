#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { execFileSync } from "node:child_process"

const root = resolve(new URL("..", import.meta.url).pathname)
const data = join(homedir(), ".config", "wac")
const logs = join(data, "logs")
const plist = join(homedir(), "Library", "LaunchAgents", "com.user.wac.plist")
mkdirSync(logs, { recursive: true, mode: 0o700 })
// Pre-create log files locked down: they can capture QR redaction notices
// and opencode error bodies, so keep them owner-only.
for (const f of ["wac.log", "wac.err.log"]) {
  try {
    writeFileSync(join(logs, f), "", { flag: "a", mode: 0o600 })
    chmodSync(join(logs, f), 0o600)
  } catch {}
}
mkdirSync(dirname(plist), { recursive: true })
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const args = [process.execPath, join(root, "dist", "index.js"), "serve"]
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.user.wac</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${esc(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${esc(join(logs, "wac.log"))}</string>
<key>StandardErrorPath</key><string>${esc(join(logs, "wac.err.log"))}</string>
</dict></plist>`
writeFileSync(plist, xml, { mode: 0o600 })
chmodSync(plist, 0o600)
try { execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, plist], { stdio: "ignore" }) } catch {}
execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { stdio: "inherit" })
console.log(`installed and loaded ${plist}`)
