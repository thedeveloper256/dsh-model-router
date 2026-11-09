#!/usr/bin/env node
// B1 spike: count the model each request used, per session, for sessions
// written after a given time. Reads $DSH_HOME/sessions (default ~/.dsh) and
// decompresses session.v4.jsonl.zstd with Node's built-in zstd (Node >= 23.8).
//
// Usage: node check-models.mjs [sinceEpochMs]
// Prints one line per session: depth (0 = root, >=1 = subagent), agent preset,
// and a count of request/header models. Also prints the PASS/FAIL verdict.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const since = Number(process.argv[2] ?? 0);
const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const root = path.join(home, "sessions");

const files = [];
for (const ws of fs.readdirSync(root)) {
  const wsDir = path.join(root, ws);
  if (!fs.statSync(wsDir).isDirectory()) continue;
  for (const s of fs.readdirSync(wsDir)) {
    for (const name of ["session.v4.jsonl.zstd", "session.jsonl.zstd"]) {
      const f = path.join(wsDir, s, name);
      if (fs.existsSync(f) && fs.statSync(f).mtimeMs >= since) files.push(f);
    }
  }
}
if (files.length === 0) {
  console.log(`No session logs modified since ${new Date(since).toISOString()} under ${root}`);
  process.exit(1);
}

// The router's prompt section in a session proves the plugin loaded there.
let routerLoaded = false;
let rootModels = new Map();
let subModels = new Map();
for (const f of files) {
  const lines = zlib.zstdDecompressSync(fs.readFileSync(f)).toString("utf8").split("\n");
  let depth = 0;
  let preset = "?";
  const counts = new Map();
  if (lines.some((l) => l.includes("Model routing is role-based"))) routerLoaded = true;
  for (const line of lines) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "session") {
      depth = Number(e.delegationDepth ?? e.data?.delegationDepth ?? 0);
      preset = e.agentPreset ?? e.data?.agentPreset ?? "?";
    }
    if (e.type === "request/header") {
      const m = e.data?.header?.config?.model ?? "?";
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
  }
  const target = depth >= 1 ? subModels : rootModels;
  for (const [m, n] of counts) target.set(m, (target.get(m) ?? 0) + n);
  const summary = [...counts].map(([m, n]) => `${m} x${n}`).join(", ") || "(no requests)";
  console.log(`depth=${depth} preset=${preset} ${path.basename(path.dirname(f))}: ${summary}`);
}

const fmt = (m) => [...m].map(([k, n]) => `${k} x${n}`).join(", ") || "(none)";
console.log(`\nroot requests:     ${fmt(rootModels)}`);
console.log(`subagent requests: ${fmt(subModels)}`);
if (!routerLoaded) {
  console.log("\nVERDICT: inconclusive: the router's prompt section is missing, so the plugin did not load. Check stderr for 'failed to import'.");
} else if (rootModels.has("deepseek-v4-pro")) {
  console.log("\nVERDICT: routing WORKS on this harness (root used the planner route deepseek-v4-pro).");
} else if (rootModels.size > 0) {
  console.log("\nVERDICT: routing NOT applied (root did not use deepseek-v4-pro).");
} else {
  console.log("\nVERDICT: inconclusive (no root requests found).");
}
