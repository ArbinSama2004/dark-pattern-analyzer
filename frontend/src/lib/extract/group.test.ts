import { afterEach, describe, expect, it } from "vitest";
import { proposeGroups, reconstructText } from "./group";
import { extractCandidatesWithElements } from "./extract";

afterEach(() => {
  document.body.innerHTML = "";
});

/** jsdom reports offsetParent as null for everything, which isVisible() reads
 * as hidden. Every fixture element is made visible the way extract.test.ts
 * does it. */
async function extract(html: string) {
  document.body.innerHTML = html;
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    Object.defineProperty(el, "offsetParent", { value: document.body, configurable: true });
  }
  return extractCandidatesWithElements("en");
}

describe("reconstructText", () => {
  it("inserts the separator the DOM leaves to CSS", () => {
    // textContent here is "Ends in09:52:11" -- the gap between label and value
    // is a stylesheet, not a text node. Sending the run-together form to a
    // model trained on written UI strings would be its own kind of skew.
    document.body.innerHTML = `<time id="t">Ends in<span>09:52:11</span></time>`;

    expect(reconstructText(document.getElementById("t")!)).toBe("Ends in 09:52:11");
  });
});

describe("proposeGroups", () => {
  it("proposes the countdown label and value as one unit", async () => {
    // The exact shape from a live Daraz flash sale. The two fragments were
    // classified separately, and in Nepali came back as two different labels
    // for one countdown.
    const pairs = await extract(
      `<div id="module_flash_sale"><time>Ends in<span>09:52:11</span></time></div>`,
    );

    const groups = proposeGroups(pairs);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("timer_label_value");
    expect(groups[0]!.text).toBe("Ends in 09:52:11");
    expect(groups[0]!.fragments).toEqual(["Ends in", "09:52:11"]);
    expect(groups[0]!.reconstructed).toBe(true);
  });

  it("proposes a currency symbol and its amount as one price", async () => {
    // From a live Jeevee product page: neither fragment is a price alone.
    const pairs = await extract(`<div class="p">3190.01<span>रु.</span></div>`);

    const groups = proposeGroups(pairs);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("currency_amount");
    expect(groups[0]!.text).toBe("3190.01 रु.");
  });

  it("proposes a was/now price pair as a comparison", async () => {
    const pairs = await extract(
      `<div class="price"><s>Rs. 2,499</s><span>Rs. 1,199</span></div>`,
    );

    const groups = proposeGroups(pairs);

    expect(groups[0]!.type).toBe("price_comparison");
    expect(groups[0]!.text).toBe("Rs. 2,499 Rs. 1,199");
    // The container already carried the whole string, so there is nothing to
    // reconstruct -- but the group still records that the two halves are
    // represented, which is what fragment suppression would need.
    expect(groups[0]!.reconstructed).toBe(false);
    expect(groups[0]!.fragments).toContain("Rs. 2,499");
  });

  it("proposes one unit, not two, when a container repeats what it holds", async () => {
    // The live Daraz markup: a wrapper div around the <time>. Both reconstruct
    // "Ends in 09:52:11". Only the inner one is kept -- the tighter anchor,
    // for the same reason the extractor keeps the innermost duplicate.
    const pairs = await extract(
      `<div id="module_flash_sale"><time>Ends in<span>09:52:11</span></time></div>`,
    );

    const groups = proposeGroups(pairs);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.fragments).toEqual(["Ends in", "09:52:11"]);
  });

  it("refuses to join text across a block-level element", async () => {
    // A block child is a new logical unit. Without this, a container would
    // eventually swallow half a page.
    const pairs = await extract(
      `<div id="outer">Some heading text here<div>An entirely separate line</div></div>`,
    );

    expect(proposeGroups(pairs)).toEqual([]);
  });

  it("refuses to fold a link's label into the prose around it", async () => {
    // <a> is an inline tag, so containment alone would merge these. A control's
    // label is its own statement -- this is the boundary that stops grouping
    // from quietly becoming "join nearby text".
    const pairs = await extract(
      `<p id="para">Read our policy before you buy <a href="/t">Terms and Conditions</a></p>`,
    );

    expect(proposeGroups(pairs)).toEqual([]);
  });

  it("proposes nothing when the parent already carries the whole string", async () => {
    // collapseNestedDuplicates already owns the identical-text case; a group
    // that reconstructs exactly what a fragment already said adds nothing.
    const pairs = await extract(`<div class="sold"><span>958 sold</span></div>`);

    expect(proposeGroups(pairs)).toEqual([]);
  });

  it("keeps every member id, so a reviewer can trace a proposal back", async () => {
    const pairs = await extract(`<time>Ends in<span>09:52:11</span></time>`);
    const [group] = proposeGroups(pairs);

    expect(group!.memberIds).toHaveLength(2);
    expect(group!.id).toBe(group!.memberIds[0]);
    expect(pairs.map((p) => p.candidate.id)).toEqual(expect.arrayContaining(group!.memberIds));
  });

  it("changes nothing about the candidates themselves", async () => {
    // Shadow mode, asserted rather than assumed: the fragments are still
    // present and unmodified after proposals are computed, because everything
    // downstream still classifies them individually.
    const pairs = await extract(`<time>Ends in<span>09:52:11</span></time>`);
    const before = pairs.map((p) => ({ ...p.candidate }));

    proposeGroups(pairs);

    expect(pairs.map((p) => p.candidate)).toEqual(before);
  });
});

describe("proposeGroups — video player readouts", () => {
  async function extractHtml(html: string) {
    document.body.innerHTML = html;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      Object.defineProperty(el, "offsetParent", { value: document.body, configurable: true });
    }
    return extractCandidatesWithElements("en");
  }

  it("does not type a video's remaining-time readout as a countdown", async () => {
    // Shadow mode caught this on a live Amazon page: "Remaining Time - 0:00"
    // and "Remaining Time - 0:36" were proposed as timer groups. That is the
    // same family that produced 10 false positives when role inference
    // trusted the MM:SS shape -- and Amazon's player matches none of the
    // class names isVideoPlayerContext knows, so the wording is matched
    // directly rather than relying on it.
    const pairs = await extractHtml(
      `<div class="controls">Remaining Time - <span>0:36</span></div>`,
    );

    const [group] = proposeGroups(pairs);

    expect(group!.text).toBe("Remaining Time - 0:36");
    expect(group!.type).not.toBe("timer_label_value");
  });

  it("still types a real deadline as a countdown", async () => {
    const pairs = await extractHtml(`<time>Ends in<span>07:33:48</span></time>`);

    expect(proposeGroups(pairs)[0]!.type).toBe("timer_label_value");
  });

  it("records whether a member was seen ticking", async () => {
    // Not a gate yet -- the signal that will decide whether timer groups can
    // ever be activated, recorded now so the decision has data behind it.
    document.body.innerHTML = `<time>Ends in<span>07:33:48</span></time>`;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      Object.defineProperty(el, "offsetParent", { value: document.body, configurable: true });
    }
    const pairs = await extractCandidatesWithElements("en", document, () => true);

    expect(proposeGroups(pairs)[0]!.animated).toBe(true);
  });
});
