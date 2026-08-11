/**
 * Which part of a product listing a piece of text is.
 *
 * `role` (role.ts) already tries to answer a related question, but it answers
 * it from the element's own tag and CSS class names, in isolation. That is why
 * a site whose wrapper class is `offer-card` turns every string inside it into
 * `promo`, and why a rule receiving `role=body` cannot tell a product title
 * from a stock warning. Measured consequence: `stock_counter` matched
 * "Limited Stock" inside a 45-character product title and reported `scarcity`
 * at the UI's strongest confidence, while the model called the same title
 * benign at 0.896.
 *
 * A field is inferred from **evidence about the text and its position in a
 * product card**, not from what the site named its CSS classes:
 *
 *   - a struck-through price is the one inside `<s>`/`<del>`
 *   - a discount is `-54%` or `54% off`
 *   - a rating is `4.6 out of 5`
 *   - a title is the longest text inside the card's own link
 *
 * Two deliberate limits:
 *
 * 1. **No site-specific selectors.** A `div.pdp-price` rule would work on one
 *    storefront and silently do nothing on every other. Everything here keys
 *    off structure (`<s>`, `<a href>`, heading tags, repeated siblings) and
 *    text shape, which are the same on Daraz, Amazon and a site neither of us
 *    has seen.
 * 2. **`unknown` is a real answer.** When the evidence does not identify a
 *    field, this says so and every consumer falls back to today's behaviour.
 *    Guessing would put a wrong field where there is currently an honest
 *    absence, which is worse: rules gate on this.
 */

export type Field =
  | "title"
  | "price"
  | "strike_price"
  | "discount"
  | "rating"
  | "sold_count"
  | "stock"
  | "shipping"
  | "prose"
  | "unknown";

/** Currency as written across the storefronts this targets: "Rs. 1,199",
 * "NPR 1,199", "₹200", "$19.99". */
const CURRENCY_RE = /(?:rs\.?|npr|inr|₹|\$|€|£)\s*[\d,]+(?:\.\d+)?/i;
const DISCOUNT_RE = /(?:^|\s)-\s?\d+\s?%|\b\d+\s*%\s*off\b/i;
const RATING_RE = /\b\d(?:\.\d+)?\s*(?:out of\s*5|\/\s*5)\b|★/i;
const SOLD_RE = /\b\d[\d,]*\+?\s*(?:pieces?\s*)?sold\b/i;
const STOCK_RE = /\bonly\s+\d+\s+(?:left|items?\s+left)\b|\b\d+\s*(?:items?\s*)?left in stock\b/i;
const SHIPPING_RE = /\bfree\s+(?:delivery|shipping)\b|\bdelivery\s+by\b/i;

/** Ancestors searched when looking for a card boundary or a struck-through
 * wrapper. Deep enough for the nested div soup storefronts emit, shallow
 * enough that a match still means something local. */
const ANCESTOR_SCAN_DEPTH = 8;

function textDecorationLineThrough(el: Element): boolean {
  if (!(el instanceof HTMLElement) || typeof getComputedStyle !== "function") return false;
  const style = getComputedStyle(el);
  return /line-through/.test(style.textDecorationLine || style.textDecoration || "");
}

/** A price the page has crossed out -- the "was" half of a discount claim.
 * Checked structurally first (`<s>`, `<del>`) and then by computed style,
 * since plenty of sites strike a `<span>` in CSS instead. */
function isStruckThrough(el: Element): boolean {
  if (typeof el.closest === "function" && el.closest("s, del")) return true;
  return textDecorationLineThrough(el);
}

/**
 * The repeating unit `el` belongs to -- one product in a grid or list.
 *
 * Found by structural repetition, not by class name: walk up until an ancestor
 * has a sibling with the same shape signature. A product grid is by
 * construction a run of near-identical subtrees, and that repetition is the
 * one signal every storefront shares regardless of its markup conventions.
 *
 * Returns null on a product *detail* page, where there is no repetition to
 * find. That is correct rather than a gap: field inference below still works
 * from local evidence, and callers must handle null anyway.
 */
export function findCardRoot(el: Element, maxDepth = ANCESTOR_SCAN_DEPTH): Element | null {
  let node: Element | null = el.parentElement;
  for (let depth = 0; node && depth < maxDepth; depth += 1, node = node.parentElement) {
    const parent = node.parentElement;
    if (!parent) break;
    let twins = 0;
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== node && looksLikeTwin(node, sibling)) twins += 1;
    }
    // One twin is enough. Two identical siblings is already a repeated
    // template; requiring three would miss the last row of a grid and any
    // two-up layout.
    if (twins >= 1) return node;
  }
  return null;
}

/** Class tokens, minus the generated-looking ones (hashed CSS-module suffixes,
 * long digit runs) that differ per element on the same template. */
function classTokens(el: Element): string[] {
  const classes = typeof el.className === "string" ? el.className : "";
  return classes.split(/\s+/).filter((token) => token.length > 0 && !/\d{3,}/.test(token));
}

/**
 * Are these two siblings renderings of the same template?
 *
 * Not exact class equality: storefronts append per-item modifiers
 * (`--sponsored`, `--sold-out`, `active`) to otherwise identical cards, and an
 * exact comparison then sees every card as unique and finds no repetition at
 * all. Requiring the smaller class set to be mostly contained in the larger
 * tolerates the modifiers while still refusing to call two unrelated `<div>`s
 * a repeated unit.
 *
 * Two class-less elements of the same tag do count -- `<li>` rows are a real
 * and common listing template.
 */
function looksLikeTwin(a: Element, b: Element): boolean {
  if (a.tagName !== b.tagName) return false;

  const tokensA = classTokens(a);
  const tokensB = classTokens(b);
  if (tokensA.length === 0 && tokensB.length === 0) return true;
  if (tokensA.length === 0 || tokensB.length === 0) return false;

  const setB = new Set(tokensB);
  const shared = tokensA.filter((token) => setB.has(token)).length;
  return shared / Math.min(tokensA.length, tokensB.length) >= 0.5;
}

/**
 * Running prose -- a customer review, a Q&A answer, a long description.
 *
 * Not a product field at all, which is the point: it is *writing*, not
 * interface copy, and the classifier was fine-tuned on interface copy (p95 of
 * the training rows is 34 tokens). A five-sentence review is off-distribution
 * input, and `confirmshaming` carries the lowest threshold of all eight
 * classes (0.11), so the noise clears it easily.
 *
 * Measured across three real pages: of 57 findings, **28 were review or Q&A
 * prose** -- the largest single false-positive family, and the entirety of
 * Jeevee's output. A shopper's opinion of a bag is not a manipulative pattern
 * and the site did not write it.
 *
 * Two cuts, both taken from that data rather than chosen a priori:
 * 25+ words, or 2+ sentences with at least 8 words. The shortest genuine
 * finding on those pages ("Login or Register to ask the seller now and answer
 * will show here.", 13 words, one sentence) sits below both.
 *
 * Roles that are structurally interactive or are consequential UI copy are
 * exempt: a forced-action gate, a decline button and fine print can all be
 * long, and those are exactly the places a dark pattern lives.
 */
const PROSE_EXEMPT_ROLES = new Set([
  "cta",
  "decline",
  "checkbox",
  "form_gate",
  "fine_print",
  "toast",
  "label",
]);
const PROSE_MIN_WORDS = 25;
const PROSE_MULTI_SENTENCE_MIN_WORDS = 8;
const SENTENCE_END_RE = /[.!?।](?:\s|$)/g;

function looksLikeProse(text: string, role: string): boolean {
  if (PROSE_EXEMPT_ROLES.has(role)) return false;

  const words = text.trim().split(/\s+/).length;
  if (words >= PROSE_MIN_WORDS) return true;

  // `।` is the Devanagari danda -- Hindi and Nepali reviews end sentences with
  // it, and a rule that only knew ASCII punctuation would quietly apply to
  // English pages alone.
  const sentences = text.match(SENTENCE_END_RE)?.length ?? 0;
  return sentences >= 2 && words >= PROSE_MULTI_SENTENCE_MIN_WORDS;
}

/**
 * Field for one candidate from its own text and element.
 *
 * Ordered most-specific-evidence-first. Discount is tested before price
 * because "-54%" carries no currency and would otherwise fall through; struck
 * price before price because both match the currency shape and only one of
 * them is what the shopper pays. Prose is tested last, so a long product title
 * or a wordy price line keeps the field its own evidence earned.
 */
export function inferField(el: Element, text: string, role = "body"): Field {
  const tag = el.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tag)) return "title";
  if (DISCOUNT_RE.test(text)) return "discount";
  if (RATING_RE.test(text)) return "rating";
  if (SOLD_RE.test(text)) return "sold_count";
  if (STOCK_RE.test(text)) return "stock";
  if (SHIPPING_RE.test(text)) return "shipping";
  if (CURRENCY_RE.test(text)) return isStruckThrough(el) ? "strike_price" : "price";
  if (looksLikeProse(text, role)) return "prose";

  return "unknown";
}

/**
 * Card-relative refinement: the title.
 *
 * A product card's title is the text the card's own link is wrapped around --
 * structurally the most reliable title signal there is, and one no class name
 * is needed for. Applied only to candidates still `unknown`, so a price or a
 * discount inside the same link keeps the field its own evidence earned.
 *
 * Longest wins because storefront cards routinely put several short strings
 * inside the link (brand chip, "Sponsored", a shipping note) alongside the one
 * long descriptive string that is the actual product name.
 */
export function refineTitleWithinCard(
  entries: Array<{ el: Element; text: string; field: Field }>,
  cardRoot: Element,
): void {
  let best: { el: Element; text: string; field: Field } | null = null;
  for (const entry of entries) {
    if (entry.field !== "unknown") continue;
    if (typeof entry.el.closest !== "function") continue;
    const link = entry.el.closest("a[href]");
    if (!link || !cardRoot.contains(link)) continue;
    if (!best || entry.text.length > best.text.length) best = entry;
  }
  if (best) best.field = "title";
}
