// Audit-completeness checker: cross-references run.json nodes against audit.jsonl events.
// Usage: node scripts/audit-check.mjs <run-dir>
import { readFileSync } from "node:fs";
import { argv } from "node:process";

const runDir = argv[2];
const run = JSON.parse(readFileSync(`${runDir}/run.json`, "utf8"));
const events = readFileSync(`${runDir}/audit.jsonl`, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const byNode = new Map();
const runEvents = [];
const orphan = []; // events whose nodeId isn't in run.json
const nodeIds = new Set(run.nodes.map((n) => n.id));

for (const e of events) {
  const id = e.nodeId;
  if (id) {
    if (!byNode.has(id)) byNode.set(id, []);
    byNode.get(id).push(e.type);
    if (!nodeIds.has(id)) orphan.push(`${id} (${e.type})`);
  } else {
    runEvents.push(e.type);
  }
}

// Event-type census
const census = new Map();
for (const e of events) census.set(e.type, (census.get(e.type) ?? 0) + 1);

console.log("=== EVENT CENSUS ===");
for (const [t, c] of [...census].sort()) console.log(`  ${t.padEnd(16)} ${c}`);

console.log("\n=== RUN-LEVEL EVENTS ===");
console.log("  ", runEvents.join(" ") || "(none)");

console.log("\n=== PER-NODE EVENT COVERAGE ===");
const missing = [];
for (const n of run.nodes) {
  const evs = byNode.get(n.id) ?? [];
  const hasStart = evs.includes("node.start");
  const terminal = evs.find((t) => t === "node.complete" || t === "node.fail" || t === "node.skip");
  const ok = hasStart && terminal;
  if (!ok) missing.push({ id: n.id, status: n.status, evs });
  console.log(
    `  ${n.id.padEnd(16)} status=${n.status.padEnd(9)} events=[${evs.join(", ")}] ${
      ok ? "OK" : "❌ MISSING"
    }`,
  );
}

console.log("\n=== ORPHAN EVENTS (nodeId not in run.json) ===");
console.log("  ", orphan.join(", ") || "(none)");

if (missing.length === 0 && orphan.length === 0) console.log("\n✅ FULL COVERAGE");
else console.log(`\n❌ ${missing.length} node(s) missing start/terminal, ${orphan.length} orphan(s)`);
