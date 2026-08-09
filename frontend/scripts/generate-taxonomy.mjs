#!/usr/bin/env node
/**
 * Regenerates src/lib/taxonomy.generated.json from the backend's Python
 * taxonomy (the single hand-written source of truth: backend/src/app/core/taxonomy.py).
 *
 * Per docs/ARCHITECTURE.md section 8: "packages/dp_core exists so the label
 * order ... [has] exactly one definition. The TypeScript side consumes a
 * generated JSON mirror of it -- never a hand-copied duplicate."
 *
 * This is a small, dependency-free parser (regex over the Python source)
 * rather than a Python subprocess call, so `npm run generate:taxonomy` works
 * without requiring the ml/backend Python environment to be set up.
 *
 * Run this:
 *   - after any change to backend/src/app/core/taxonomy.py
 *   - before a release build, as a CI check that the two haven't drifted
 *
 * Usage: node scripts/generate-taxonomy.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_TAXONOMY = path.resolve(
  __dirname,
  "../../backend/src/app/core/taxonomy.py",
);
const OUT_FILE = path.resolve(
  __dirname,
  "../src/lib/taxonomy.generated.json",
);

function extractTuple(source, constName) {
  const re = new RegExp(`${constName}[^=]*=\\s*\\(([\\s\\S]*?)\\)`, "m");
  const match = source.match(re);
  if (!match) {
    throw new Error(`Could not find ${constName} in ${BACKEND_TAXONOMY}`);
  }
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function extractDescriptions(source) {
  const re = /LABEL_DESCRIPTIONS[^=]*=\s*\{([\s\S]*?)\n\}/m;
  const match = source.match(re);
  if (!match) {
    throw new Error(`Could not find LABEL_DESCRIPTIONS in ${BACKEND_TAXONOMY}`);
  }
  const body = match[1];
  const entries = [...body.matchAll(/"([a-z_]+)":\s*"((?:[^"\\]|\\.)*)"/g)];
  return Object.fromEntries(entries.map(([, k, v]) => [k, v]));
}

function extractLangs(source) {
  const re = /LANGS[^=]*=\s*\(([\s\S]*?)\)/m;
  const match = source.match(re);
  if (!match) {
    throw new Error(`Could not find LANGS in ${BACKEND_TAXONOMY}`);
  }
  return [...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

function main() {
  const source = readFileSync(BACKEND_TAXONOMY, "utf-8");

  const expectedLabels = extractTuple(source, "EXPECTED_LABELS");
  const benignLabel = source.match(/BENIGN_LABEL\s*=\s*"([a-z_]+)"/)?.[1];
  const darkLabels = expectedLabels.filter((l) => l !== benignLabel);
  const descriptions = extractDescriptions(source);
  const langs = extractLangs(source);

  if (!benignLabel) {
    throw new Error("Could not find BENIGN_LABEL");
  }
  if (expectedLabels.length !== 8) {
    throw new Error(
      `Expected 8 labels, parsed ${expectedLabels.length}: ${expectedLabels.join(", ")}. ` +
        `The regex parser may need updating if taxonomy.py's format changed.`,
    );
  }

  const out = {
    _generated_from: "backend/src/app/core/taxonomy.py",
    _warning: "Do not hand-edit. Run `npm run generate:taxonomy`.",
    expectedLabels,
    darkLabels,
    benignLabel,
    descriptions,
    langs,
  };

  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`  labels: ${expectedLabels.join(", ")}`);
}

main();
