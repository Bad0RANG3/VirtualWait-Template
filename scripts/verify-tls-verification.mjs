#!/usr/bin/env node
/**
 * TLS guard: SDGB / AiMe HTTP requests must keep certificate verification on.
 * Mirrors the "Reject disabled TLS verification" step in .github/workflows/verify.yml.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["packages", "services"];
const SKIP_DIRS = new Set(["node_modules", ".next", "__pycache__", ".venv", ".pytest_cache"]);
const PATTERN = /verify\s*=\s*False/;

function* pythonFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* pythonFiles(full);
    else if (entry.endsWith(".py")) yield full;
  }
}

const offenders = [];
for (const dir of SCAN_DIRS) {
  const abs = path.join(root, dir);
  if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const file of pythonFiles(abs)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (PATTERN.test(line)) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
    });
  }
}

if (offenders.length) {
  console.error("TLS certificate verification must stay enabled for SDGB/AiMe requests:");
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.info("TLS verification guard OK");
