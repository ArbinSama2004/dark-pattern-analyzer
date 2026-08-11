import type { Candidate, Field } from "../extract/types";
import { stockCounter } from "./stock_counter";
import { countdownTimer } from "./countdown_timer";
import { viewerCounter } from "./viewer_counter";
import { precheckedOptin } from "./prechecked_optin";
import { hiddenOptout } from "./hidden_optout";
import { ctaAsymmetry } from "./cta_asymmetry";
import { lateFee } from "./late_fee";
import { cancelOffsite } from "./cancel_offsite";
import { discountBadge } from "./discount_badge";
import { forcedActionGate } from "./forced_action_gate";
import { recentActivity } from "./recent_activity";
import type { Rule, RuleHit } from "./types";

/** All rules from docs/ARCHITECTURE.md 4.5, plus discount_badge for
 * e-commerce discount-badge pattern coverage, forced_action_gate for
 * structural corroboration of forced_action, and recent_activity for
 * time-bounded purchase claims (which stock_counter used to mislabel as
 * scarcity -- see docs/RESULTS.md sections 6-7). */
const RULES: Rule[] = [
  stockCounter,
  countdownTimer,
  viewerCounter,
  precheckedOptin,
  hiddenOptout,
  ctaAsymmetry,
  lateFee,
  cancelOffsite,
  discountBadge,
  forcedActionGate,
  recentActivity,
];

/**
 * Fields a text-matching rule must never fire on.
 *
 * The rules are unanchored regexes over whatever string they are handed, with
 * no idea what that string is. `stock_counter` matching "Limited Stock" is
 * correct on a badge that reads "Limited Stock -- only 3 left" and wrong on
 * "Hot Sale Wireless Earbuds Limited Stock Offer", which is a seller's title
 * copy. Nothing in the text distinguishes them; the *field* does.
 *
 * Why a deny-list per rule rather than one global "never judge titles":
 * `recent_activity` firing on a title would be just as wrong, but
 * `cta_asymmetry` reading a title is meaningless rather than harmful, and a
 * blanket rule would need every future rule to opt out correctly. Naming the
 * fields each rule is known to misfire on keeps the claim narrow and
 * reviewable against docs/ANNOTATION.md.
 *
 * Only the four text-matching rules are listed. The rules that read live DOM
 * state (prechecked_optin, hidden_optout, cta_asymmetry, cancel_offsite,
 * forced_action_gate, countdown_timer's cadence check) are judging structure,
 * not wording, and structure means the same thing wherever it appears.
 *
 * A candidate whose field is `unknown` is never blocked -- absence of evidence
 * is not evidence, and blocking on it would silently disable rules on every
 * page whose markup this cannot read.
 */
const FIELD_DENY_LIST: Record<string, readonly Field[]> = {
  // Seller-written product copy. A title containing "Limited Stock" or
  // "Lowest Price" is marketing prose; docs/ANNOTATION.md treats a settled
  // claim as benign, and the classifier agrees (real titles score benign
  // ~0.90). Ratings and prices are settled facts by the same test.
  stock_counter: ["title", "rating", "price", "strike_price", "prose", "personal"],
  recent_activity: ["title", "rating", "price", "strike_price", "prose", "personal"],
  viewer_counter: ["title", "rating", "price", "strike_price", "prose", "personal"],
  // A discount belongs on a discount. Left free to fire on `discount` itself,
  // which is what the rule is for.
  discount_badge: ["title", "rating", "sold_count", "prose", "personal"],
  // A ticking number is only a deadline in some places. `countdown_timer`
  // tests `is_animated` and nothing else -- there is no clock-shape check --
  // so a live viewer count, a rotating price or an animated rating would all
  // have been reported as `false_urgency`. Naming the fields where a changing
  // number is not a countdown is narrower than inventing a text-shape test
  // that a "2 days 04 hours" deadline would fail.
  countdown_timer: ["price", "strike_price", "rating", "sold_count", "title", "prose", "personal"],
  // A product title is never an interactive control. Defence in depth behind
  // the word-boundary fix in role.ts: these two only fired on titles because
  // "Noise Cancelling" had been mistyped as role=decline, and a second
  // independent reason to refuse costs nothing.
  cancel_offsite: ["title", "prose", "personal"],
  cta_asymmetry: ["title"],
};

/** True if `rule` is allowed to report a hit on a candidate in `field`. */
export function ruleAllowedOnField(rule: string, field: Field): boolean {
  if (field === "unknown") return true;
  return !(FIELD_DENY_LIST[rule] ?? []).includes(field);
}

export function runRules(candidate: Candidate, el: Element): RuleHit[] {
  return RULES.flatMap((rule) => rule(candidate, el)).filter((hit) =>
    ruleAllowedOnField(hit.rule, candidate.field),
  );
}

export * from "./types";
