/**
 * Builds a stable-enough CSS path for re-locating an element later, e.g. to
 * scroll-and-highlight from the side panel. Not guaranteed unique on a
 * pathological page, but good enough for same-session lookups -- the primary
 * identity for dedupe/caching is the text hash (hash.ts), not this selector.
 */
export function stableSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
    let part = node.tagName.toLowerCase();

    if (node.id) {
      part += `#${CSS.escape(node.id)}`;
      parts.unshift(part);
      break; // an id is unique enough to stop climbing
    }

    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (sib) => sib.tagName === node!.tagName,
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(node) + 1;
        part += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(part);
    node = node.parentElement;
  }

  return parts.join(" > ");
}
