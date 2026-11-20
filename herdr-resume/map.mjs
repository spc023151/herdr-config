// Remember which herdr terminal (HC_TERMINAL_ID, e.g. "t9") runs which agent session,
// so herdr-shell.ps1 can resume it after a reboot. Outside herdr it does nothing.
//   node map.mjs start          Claude SessionStart hook (event JSON on stdin)
//   node map.mjs end            Claude SessionEnd hook: closed on purpose, forget it
//   node map.mjs codex '<json>' Codex `notify` (event JSON as the last argument)
// Never fails the caller.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dir, "sessions.json");
const term = process.env.HC_TERMINAL_ID;
const mode = process.argv[2];

const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
function save(map) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, file);
}

// Codex flags worth replaying on resume; positionals (a prompt, "resume <id>") are dropped.
const VALUED = new Set(["-C", "--cd", "-m", "--model", "-p", "--profile", "-c", "--config", "-s", "--sandbox", "-a", "--ask-for-approval", "--add-dir", "--oss", "--local-provider"]);
function splitArgs(cmd) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2]);
  return out;
}
function codexFlags(cmdline) {
  const toks = splitArgs(cmdline).slice(1);
  const flags = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t.startsWith("-")) continue;
    flags.push(t);
    if (VALUED.has(t) && i + 1 < toks.length) flags.push(toks[++i]);
  }
  return flags;
}

// The interactive codex.exe that called us, unless it runs under Claude (the codex plugin)
// or is a non-interactive subcommand. Returns its command line, or null to skip.
function interactiveCodex() {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8", timeout: 15000, windowsHide: true });
  const procs = new Map(JSON.parse(r.stdout || "[]").map((p) => [p.ProcessId, p]));
  let p = procs.get(process.ppid);
  let codex = null;
  for (let hops = 0; p && hops < 12; hops++, p = procs.get(p.ParentProcessId)) {
    const name = (p.Name || "").toLowerCase();
    if (name === "claude.exe") return null;
    if (!codex && name === "codex.exe") codex = p;
  }
  if (!codex) return null;
  const sub = splitArgs(codex.CommandLine || "").slice(1).find((t) => !t.startsWith("-"));
  if (sub && ["exec", "e", "app-server", "mcp", "mcp-server", "proto", "review"].includes(sub)) return null;
  return codex.CommandLine;
}

function codexEvent() {
  let ev = {};
  try { ev = JSON.parse(process.argv[process.argv.length - 1]); } catch { return; }
  const id = ev["thread-id"] ?? ev.thread_id ?? ev["session-id"] ?? ev.session_id;
  if (!id) return;
  const map = load();
  const cur = map[term];
  if (cur?.kind === "codex" && cur.sessionId === id) return; // fast path: nothing changed
  // An interactive codex in this terminal (checked below) means no Claude runs here any more.
  const cmdline = interactiveCodex();
  if (!cmdline) return;
  map[term] = { kind: "codex", sessionId: id, cwd: ev.cwd ?? process.cwd(), flags: codexFlags(cmdline), at: new Date().toISOString() };
  save(map);
}

try {
  if (term && mode === "codex") codexEvent();
} catch {}

if (mode === "start" || mode === "end") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    try {
      if (!term) return;
      const ev = JSON.parse(input || "{}");
      const map = load();
      if (mode === "start" && ev.session_id) {
        map[term] = { kind: "claude", sessionId: ev.session_id, cwd: ev.cwd ?? process.cwd(), at: new Date().toISOString() };
      } else if (mode === "end") {
        // Only forget it if this terminal still points at the session that ended.
        if (map[term] && (!ev.session_id || map[term].sessionId === ev.session_id)) delete map[term];
      } else return;
      save(map);
    } catch {}
  });
}
