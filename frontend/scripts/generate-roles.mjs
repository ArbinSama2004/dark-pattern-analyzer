#!/usr/bin/env node
/**
 * Regenerates src/lib/roles.generated.json from the real training data
 * (data/synthetic/dataset_all.csv) -- the actual source of truth for the
 * role vocabulary, since there is no hand-written Python ROLES constant
 * (see backend/src/app/core/model_input.py: normalize_role only lowercases
 * and folds separators, it doesn't validate against a fixed set).
 *
 * docs/ARCHITECTURE.md section 4.1 previously listed an invented vocabulary
 * (`cancel`, `accept`, `optout`, `banner`, `label`, `body`) that does not
 * match what the model was trained on. Sending an unseen role token is not
 * an error anywhere in the pipeline -- normalize_role() just lowercases it
 * and passes it through -- so it silently pushes the model off-distribution.
 * This generator, plus the runtime assert in role.ts, is what stands in for
 * that missing validation.
 *
 * Run this:
 *   - after any change to data/synthetic/dataset_all.csv (e.g. a dataset
 *     regeneration)
 *   - before a release build, as a CI check that the frontend's role
 *     vocabulary hasn't drifted from what the model actually saw
 *
 * Usage: node scripts/generate-roles.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_CSV = path.resolve(
  __dirname,
  "../../data/synthetic/dataset_all.csv",
);
const OUT_FILE = path.resolve(__dirname, "../src/lib/roles.generated.json");

/** Minimal CSV parser: good enough for our generator's own dataset export,
 * not intended as a general-purpose CSV library. Handles quoted fields with
 * embedded commas/quotes, which the `text` column relies on. */
function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inQuotes) {
      if (c === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip, \n handles the row break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function main() {
  const source = readFileSync(DATASET_CSV, "utf-8");
  const rows = parseCsv(source);
  const header = rows[0];
  const roleIdx = header.indexOf("role");
  if (roleIdx === -1) {
    throw new Error(
      `Could not find a "role" column in ${DATASET_CSV}. Header was: ${header.join(", ")}`,
    );
  }

  const roles = new Set();
  for (const row of rows.slice(1)) {
    if (row.length <= roleIdx) continue;
    const value = row[roleIdx].trim();
    if (value) roles.add(value);
  }

  const sorted = [...roles].sort();

  const out = {
    _generated_from: "data/synthetic/dataset_all.csv",
    _warning: "Do not hand-edit. Run `npm run generate:roles`.",
    roles: sorted,
  };

  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`  ${sorted.length} roles: ${sorted.join(", ")}`);
}

main();
