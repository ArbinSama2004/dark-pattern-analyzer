import type { Candidate } from "../extract/types";
import { stockCounter } from "./stock_counter";
import { countdownTimer } from "./countdown_timer";
import { viewerCounter } from "./viewer_counter";
import { precheckedOptin } from "./prechecked_optin";
import { hiddenOptout } from "./hidden_optout";
import { ctaAsymmetry } from "./cta_asymmetry";
import { lateFee } from "./late_fee";
import { cancelOffsite } from "./cancel_offsite";
import type { Rule, RuleHit } from "./types";

/** All eight rules from docs/ARCHITECTURE.md 4.5. */
const RULES: Rule[] = [
  stockCounter,
  countdownTimer,
  viewerCounter,
  precheckedOptin,
  hiddenOptout,
  ctaAsymmetry,
  lateFee,
  cancelOffsite,
];

export function runRules(candidate: Candidate, el: Element): RuleHit[] {
  return RULES.flatMap((rule) => rule(candidate, el));
}

export * from "./types";
