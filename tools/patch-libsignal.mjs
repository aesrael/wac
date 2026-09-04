import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

// libsignal logs complete session objects, including private key buffers, with
// console.info(). Silence only those three diagnostics. The library continues
// to function normally and warnings/errors are left intact.
const file = resolve("node_modules/libsignal/src/session_record.js")
if (!existsSync(file)) process.exit(0)

const source = readFileSync(file, "utf8")
const replacements = [
  ['console.info("Migrating session to:", migrations[i].version);', '/* sensitive session migration log suppressed */'],
  ['console.warn("Session already closed", session);', '/* sensitive session log suppressed */'],
  ['console.info("Closing session:", session);', '/* sensitive session log suppressed */'],
  ['console.info("Opening session:", session);', '/* sensitive session log suppressed */'],
  ['console.info("Removing old closed session:", oldestSession);', '/* sensitive session log suppressed */'],
]
let patched = source
let applied = 0
for (const [from, to] of replacements) {
  if (patched.includes(from)) {
    patched = patched.replace(from, to)
    applied++
  }
}

if (patched !== source) writeFileSync(file, patched)
if (applied === 0) {
  console.error("patch-libsignal: WARNING — 0 replacements applied; libsignal may have changed and session keys may log again")
  process.exitCode = 1
}
