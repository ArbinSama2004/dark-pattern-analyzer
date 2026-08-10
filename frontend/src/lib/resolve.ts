/**
 * Prediction -> DOM resolution (Fix 2).
 *
 * Fix 1 gave every DOM occurrence its own id (hash.ts's occurrenceId), so a
 * prediction is no longer ambiguous about *which* text string it describes.
 * This module is the other half: turning that occurrence id back into a live
 * element without recreating the collision problem Fix 1 removed. It never
 * accepts a match on text alone, and it refuses to guess when more than one
 * equally-good candidate exists.
 *
 * Resolution order, each tier strictly less certain than the last:
 *
 *   1. registry hit  -- the exact node captured at extraction time, still
 *                        attached. This is ground truth: if it's still the
 *                        same connected node, it IS the occurrence, even if
 *                        its text has since ticked (a countdown timer, a
 *                        stock counter). Only the tag is re-checked, as a
 *                        cheap guard against a framework recycling the node
 *                        for unrelated content (virtualized-list reuse).
 *
 *   2. selector hit  -- document.querySelector(item.selector) resolves, and
 *                        the node there matches both tag and text. Re-query
 *                        can land on a *different* node than the one
 *                        originally captured if the DOM shifted (a sibling
 *                        removed above it, say) -- full verification is what
 *                        catches that when it changes the tag or text.
 *
 *   3. structural re-scan -- every element under the search root with a
 *                        matching tag AND matching text is a candidate.
 *                        Accepted only when there is EXACTLY one. More than
 *                        one is refused, not guessed -- this is what stops
 *                        the doc's canonical failure case (Product A's stale
 *                        reference silently repointing at Product B's
 *                        identical-looking "Add to Cart" button).
 *
 * A resolved element is also refused, at tiers 2 and 3, if it is already the
 * registry's resolved element for a *different* occurrence id -- two
 * occurrences must never both end up highlighting the same physical node.
 *
 * If nothing produces a confident, unambiguous match, resolution fails
 * closed: null, not a guess. A missing badge is recoverable (the next
 * extraction pass gets another chance); a badge on the wrong product is not.
 */

export interface ResolvableItem {
  id: string;
  text: string;
  tag: string;
  selector: string;
}

export type ResolveOutcome =
  | "registry"
  | "selector"
  | "reresolved"
  | "ambiguous"
  | "claimed"
  | "stale-recycled"
  | "not-found";

export interface ResolveDiagnostic {
  id: string;
  text: string;
  outcome: ResolveOutcome;
  matchCount?: number;
}

export interface ResolveOptions {
  /** Defaults to `document`. Overridable so tests can scope a scan without
   * depending on jsdom's global document lifecycle between test files. */
  root?: ParentNode;
  onDiagnostic?: (diagnostic: ResolveDiagnostic) => void;
}

/** Elements scanned before giving up on a structural re-scan. A cap matters:
 * on a large listing page an unbounded scan runs per unresolved finding. */
const STRUCTURAL_SCAN_LIMIT = 4000;

const OVERLAY_HOST_ID = "dark-pattern-analyzer-overlay-host";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * `tag` is typed as always-present (ClassifyItemResult.tag), but a value
 * crossing chrome.storage.session survives a build that predates the field
 * -- a tab left open across an extension reload, or a "findings:<tabId>"
 * entry written by an older content script, can hand this function
 * `undefined` at runtime despite what the type says. Treating that as "no
 * match" (not throwing) is what stopped a single stale stored item from
 * crashing overlay.ts's entire render pass -- see that file's per-item
 * try/catch for the other half of this fix.
 */
function tagMatches(el: Element, tag: string): boolean {
  if (typeof tag !== "string") return false;
  return el.tagName.toLowerCase() === tag.toLowerCase();
}

/** Containment, not just equality -- extraction may have used only an
 * element's direct text, or joined inline children (extract.ts's
 * leafBlockText), so the live element's full textContent can legitimately be
 * a superset of the recorded text. */
function textMatches(el: Element, text: string): boolean {
  const target = normalizeText(text);
  if (!target) return false;
  const actual = normalizeText(el.textContent);
  return actual === target || actual.includes(target);
}

function querySelectorSafe(root: ParentNode, selector: string): Element | null {
  if (!selector) return null;
  try {
    return root.querySelector(selector);
  } catch {
    // A path built around an id with exotic characters can be rejected as a
    // syntax error even though the underlying node reference logic is fine.
    return null;
  }
}

/**
 * Every element under `root` with a matching tag AND matching text.
 * Deliberately unordered/unranked -- there is no principled way to prefer
 * one candidate over another once tag and text both match, and picking one
 * anyway is exactly the guess this module exists to refuse.
 */
function findStructuralMatches(root: ParentNode, item: ResolvableItem): Element[] {
  const target = normalizeText(item.text);
  if (target.length < 3) return [];

  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as Element;
      if (el.id === OVERLAY_HOST_ID) return NodeFilter.FILTER_REJECT;
      return tagMatches(el, item.tag) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  const matches: Element[] = [];
  let scanned = 0;
  let node = walker.nextNode() as Element | null;
  while (node && scanned < STRUCTURAL_SCAN_LIMIT) {
    scanned += 1;
    if (textMatches(node, item.text)) matches.push(node);
    node = walker.nextNode() as Element | null;
  }
  return matches;
}

/**
 * True if `el` is already the resolved element for a *different* occurrence
 * in `registry`. Without this, tiers 2 and 3 could independently resolve two
 * different occurrence ids onto the same physical node -- e.g. if Product
 * A's element is removed and Product B's slides into the selector position
 * A's candidate remembers, both A and B's items would otherwise badge the
 * same button.
 */
function isClaimedByAnotherOccurrence(
  el: Element,
  itemId: string,
  registry: ReadonlyMap<string, Element>,
): boolean {
  for (const [otherId, otherEl] of registry) {
    if (otherId !== itemId && otherEl === el) return true;
  }
  return false;
}

export function resolveOccurrence(
  item: ResolvableItem,
  registry: Map<string, Element>,
  options: ResolveOptions = {},
): Element | null {
  const root = options.root ?? document;
  const report = (outcome: ResolveOutcome, matchCount?: number): null => {
    options.onDiagnostic?.({ id: item.id, text: item.text, outcome, matchCount });
    return null;
  };

  // Tier 1: the exact node captured at extraction time. Ground truth if
  // still connected -- text is deliberately NOT re-checked here (a ticking
  // countdown timer or stock counter is still "the same occurrence" even
  // though its text has changed since extraction; requiring text equality
  // at this tier would wrongly evict a perfectly good live reference).
  const cached = registry.get(item.id);
  if (cached) {
    if (cached.isConnected && tagMatches(cached, item.tag)) {
      options.onDiagnostic?.({ id: item.id, text: item.text, outcome: "registry" });
      return cached;
    }
    // Disconnected, or the tag changed under us (a framework recycled this
    // node for unrelated content -- virtualized-list reuse). Either way this
    // reference no longer stands for the occurrence it was captured for.
    registry.delete(item.id);
    if (cached.isConnected) {
      // Connected but no longer the right kind of node at all -- worth its
      // own diagnostic bucket, distinct from a plain disconnect, since it
      // points at a different failure mode (node recycling) than an SPA
      // simply removing the node.
      options.onDiagnostic?.({ id: item.id, text: item.text, outcome: "stale-recycled" });
    }
  }

  // Tier 2: the positional path captured at extraction time.
  const bySelector = querySelectorSafe(root, item.selector);
  if (bySelector && tagMatches(bySelector, item.tag) && textMatches(bySelector, item.text)) {
    if (isClaimedByAnotherOccurrence(bySelector, item.id, registry)) {
      return report("claimed");
    }
    registry.set(item.id, bySelector);
    options.onDiagnostic?.({ id: item.id, text: item.text, outcome: "selector" });
    return bySelector;
  }

  // Tier 3: deterministic re-resolution by structural metadata (tag + text),
  // never by text alone. Accepted only when exactly one candidate remains.
  const structuralMatches = findStructuralMatches(root, item).filter(
    (el) => !isClaimedByAnotherOccurrence(el, item.id, registry),
  );
  if (structuralMatches.length === 1) {
    const resolved = structuralMatches[0];
    if (resolved) {
      registry.set(item.id, resolved);
      options.onDiagnostic?.({ id: item.id, text: item.text, outcome: "reresolved" });
      return resolved;
    }
  }
  if (structuralMatches.length > 1) {
    return report("ambiguous", structuralMatches.length);
  }

  return report("not-found");
}
