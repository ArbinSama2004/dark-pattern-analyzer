/**
 * Typed wrapper around taxonomy.generated.json. Never hand-edit the JSON --
 * run `npm run generate:taxonomy` after changing
 * backend/src/app/core/taxonomy.py.
 */
import generated from "./taxonomy.generated.json";

export type Label =
  | "confirmshaming"
  | "false_urgency"
  | "forced_action"
  | "obstruction"
  | "scarcity"
  | "sneaking"
  | "social_proof"
  | "benign";

export const EXPECTED_LABELS = generated.expectedLabels as Label[];
export const DARK_LABELS = generated.darkLabels as Exclude<Label, "benign">[];
export const BENIGN_LABEL = generated.benignLabel as "benign";
export const LABEL_DESCRIPTIONS = generated.descriptions as Record<
  Label,
  string
>;
export const LANGS = generated.langs as ("en" | "hi" | "ne")[];
export type Lang = (typeof LANGS)[number];

/** Runtime guard -- if this ever throws, the generated mirror is stale. Run
 * `npm run generate:taxonomy` and rebuild. */
export function assertLabelOrder(labels: string[]): asserts labels is Label[] {
  if (
    labels.length !== EXPECTED_LABELS.length ||
    !labels.every((l, i) => l === EXPECTED_LABELS[i])
  ) {
    throw new Error(
      `Label order mismatch. Expected [${EXPECTED_LABELS.join(", ")}], got [${labels.join(", ")}]. ` +
        `The frontend's taxonomy mirror may be stale -- run npm run generate:taxonomy.`,
    );
  }
}
