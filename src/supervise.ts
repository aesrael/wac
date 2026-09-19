// Supervision: restart handovers, singleton enforcement, daemon liveness.
// Everything about running under launchd/systemd (or standalone) lives
// here; index.ts calls in and stays out of process mechanics.
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, openSync } from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import { join, resolve, dirname, basename } from "node:path"

/** True when running under a supervisor that restarts us on nonzero exit. */
export function supervised(): boolean {
  return process.env.WAC_SUPERVISED === "1"
}

/** Nonzero exit asks a supervisor (launchd KeepAlive, systemd on-failure) to relaunch. */
export const RESTART_EXIT_CODE = 2

export function projectRoot(): string {
  const script = process.argv[1] ?? ""
  if (script) {
    const dir = dirname(resolve(script))
    // node dist/index.js serve → <root>/dist ; <root>/bin/* → <root>
    if (basename(dir) === "dist" || basename(dir) === "bin") return resolve(dir, "..")
    // node wac serve → <root>/wac (the wrapper lives in the root itself)
    if (basename(script) === "wac") return dir
    if (existsSync(join(dir, "package.json"))) return dir
  }
  return process.cwd()
}

function tscEntry(): string | undefined {
  // launchd runs with a skeletal PATH (no npx), so never rely on PATH
  // lookup: run the bundled compiler with this same node binary.
  const cands = [
    join(projectRoot(), "node_modules", "typescript", "bin", "tsc"),
    join(projectRoot(), "node_modules", "typescript", "lib", "tsc.js"),
  ]
  for (const c of cands) {
    try {
      if (existsSync(c)) return c
    } catch { /* ignore */ }
  }
  return undefined
}

export function runTscGate(): { ok: boolean; error?: string } {
  const entry = tscEntry()
  if (!entry) return { ok: false, error: "typescript compiler not found under node_modules — run npm install" }
  try {
    execFileSync(process.execPath, [entry], { cwd: projectRoot(), timeout: 120_000, stdio: "pipe" })
    return { ok: true }
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const detail = (err.stderr?.toString() ?? err.stdout?.toString() ?? err.message ?? "tsc failed").trim().split("\n").slice(0, 5).join("\n")
    return { ok: false, error: detail }
  }
}

function successorScript(): string {
  const root = projectRoot()
  const dist = join(root, "dist", "index.js")
  if (existsSync(dist)) return dist
  return process.argv[1] ?? dist
}

function successorLog(dataDir: string, name: string): number | "ignore" {
  try {
    const dir = join(dataDir, "logs")
    mkdirSync(dir, { recursive: true })
    return openSync(join(dir, name), "a")
  } catch {
    return "ignore"
  }
}

export function spawnSuccessor(oldPid: number, dataDir: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, WAC_TAKEOVER_FROM: String(oldPid) }
  // WAC_WELCOME is strictly opt-out: never inherit a suppression from an
  // ancestor generation — every handover announces itself.
  delete env.WAC_WELCOME
  // Successor logs to the same files so handovers stay observable.
  const stdio: ["ignore", number | "ignore", number | "ignore"] = [
    "ignore",
    successorLog(dataDir, "wac.log"),
    successorLog(dataDir, "wac.err.log"),
  ]
  const child = spawn(process.execPath, [successorScript(), "serve", "--takeover-from", String(oldPid)], {
    cwd: projectRoot(),
    detached: true,
    stdio,
    env,
  })
  child.unref()
}

/** Poll until oldPid is gone (or clearly not wac/node after PID reuse). True = dead, false = still stuck. */
export async function waitForOldDeath(oldPid: number, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(oldPid)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return !isPidAlive(oldPid)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false // ESRCH: gone
  }
  // PID reuse guard: only treat node/wac as "still the old daemon".
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 3000 }).trim()
    if (!out) return false
    return out.includes("node") || out.includes("wac")
  } catch {
    return true // ps failed: assume alive, keep waiting
  }
}

function pidPath(dataDir: string): string {
  return join(dataDir, "daemon.pid")
}

export function acquireLock(dataDir: string): void {
  const path = pidPath(dataDir)
  try {
    const existing = readFileSync(path, "utf8").trim()
    if (existing) {
      const pid = Number(existing)
      if (Number.isFinite(pid) && pid !== process.pid) {
        try {
          process.kill(pid, 0) // signal 0: existence check only
          const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 3000 }).trim()
          if (out && (out.includes("node") || out.includes("wac"))) {
            console.error(`wac is already running (PID ${pid}) — exiting`)
            process.exit(0)
          }
        } catch {
          /* stale lock — fall through and overwrite */
        }
      }
    }
  } catch {
    /* no pid file yet */
  }
  writeFileSync(path, String(process.pid))
  // auto-release on exit — but only if the pidfile still holds OUR pid.
  // A detached /restart successor rewrites this file after we die; an
  // unconditional unlink here would delete the successor's lock.
  const ownPid = process.pid
  process.on("exit", () => {
    try {
      if (readFileSync(path, "utf8").trim() === String(ownPid)) unlinkSync(path)
    } catch { /* best effort */ }
  })
}

let restartArmed = false

/**
 * tsc gate → arm the handover. Supervised: nothing to spawn, the exit
 * below is the whole request. Standalone: spawn a detached successor.
 * Returns error text on failure, otherwise the mode for the exit step.
 */
export function attemptRestart(dataDir: string): { error?: string; supervised?: boolean } {
  if (restartArmed) return { supervised: supervised() } // duplicate tap while exiting
  const gate = runTscGate()
  if (!gate.ok) return { error: `(error) not restarting — build fails:\n${gate.error}` }
  if (supervised()) {
    restartArmed = true
    return { supervised: true }
  }
  try {
    spawnSuccessor(process.pid, dataDir)
  } catch (error) {
    return { error: `(error) not restarting — could not spawn successor (${(error as Error).message})` }
  }
  restartArmed = true
  return { supervised: false }
}

/** PIDs (besides our own) running this same daemon entrypoint. */
export function siblingServePids(ownPid: number, entry: string): number[] {
  const out: number[] = []
  try {
    const ps = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8", timeout: 5000 })
    for (const line of ps.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/)
      if (!m) continue
      const pid = Number(m[1])
      if (pid === ownPid) continue
      if (m[2].includes(entry) && /(^|\s)serve(\s|$)/.test(m[2])) out.push(pid)
    }
  } catch { /* ps failed: cull nothing */ }
  return out
}

function sameEntryCmd(cmd: string, entry: string): boolean {
  return !!cmd && cmd.includes(entry) && /(^|\s)serve(\s|$)/.test(cmd)
}

/** TERM, wait, KILL a stale generation — re-verifying cmdline so PID reuse
 *  never kills an innocent process. True = gone (or was never ours). */
export async function killStalePid(pid: number, entry: string): Promise<boolean> {
  const cmdOf = (p: number): string => {
    try {
      return execFileSync("ps", ["-p", String(p), "-o", "command="], { encoding: "utf8", timeout: 3000 }).trim()
    } catch {
      return ""
    }
  }
  if (!sameEntryCmd(cmdOf(pid), entry)) return true
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return true
  }
  const start = Date.now()
  while (Date.now() - start < 3000) {
    await new Promise((r) => setTimeout(r, 250))
    if (!sameEntryCmd(cmdOf(pid), entry)) return true
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    return true
  }
  await new Promise((r) => setTimeout(r, 500))
  return !sameEntryCmd(cmdOf(pid), entry)
}
