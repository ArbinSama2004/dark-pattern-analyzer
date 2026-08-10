/**
 * Geometry tests for badge placement.
 *
 * Deliberately limited to the pure functions. jsdom implements no layout --
 * getBoundingClientRect() and offsetWidth are always 0 there -- so a test that
 * mounted the overlay and asserted on where badges "landed" would be asserting
 * against a world where nothing has a size, and would pass no matter how wrong
 * the placement logic was. Extracting the geometry into pure functions taking
 * explicit boxes is what makes the interesting behaviour testable at all.
 */
import { describe, expect, it } from "vitest";
import { chooseBadgePosition, intersectionArea, positionPenalty, type Box } from "./overlay";

function box(top: number, left: number, width: number, height: number): Box {
  return { top, left, right: left + width, bottom: top + height };
}

const VIEWPORT = { width: 1200, height: 800 };
const BADGE = { width: 120, height: 20 };

describe("intersectionArea", () => {
  it("is 0 for disjoint boxes", () => {
    expect(intersectionArea(box(0, 0, 10, 10), box(100, 100, 10, 10))).toBe(0);
  });

  it("is 0 for boxes that merely touch edges", () => {
    expect(intersectionArea(box(0, 0, 10, 10), box(0, 10, 10, 10))).toBe(0);
  });

  it("returns the overlapping area", () => {
    expect(intersectionArea(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe(25);
  });
});

describe("chooseBadgePosition", () => {
  it("prefers directly above the target when nothing is in the way", () => {
    const target = box(400, 300, 200, 40);
    const placed = chooseBadgePosition(target, BADGE, [], [], VIEWPORT);

    expect(placed.bottom).toBeLessThanOrEqual(target.top);
    expect(placed.left).toBe(target.left);
  });

  it("moves below when the space above is occupied by text", () => {
    const target = box(400, 300, 200, 40);
    // A text run filling the entire band above the target.
    const textAbove = box(360, 0, VIEWPORT.width, 40);

    const placed = chooseBadgePosition(target, BADGE, [textAbove], [], VIEWPORT);

    expect(intersectionArea(placed, textAbove)).toBe(0);
    expect(placed.top).toBeGreaterThanOrEqual(target.bottom);
  });

  it("goes beside the target when both above and below are occupied", () => {
    // The reported bug's shape: a price block where the discount sits between
    // the current price above and more content below, so neither vertical
    // position is available. The old above-else-below strategy had no third
    // option and covered the price; this must find the horizontal gutter.
    const target = box(400, 300, 100, 20);
    const textAbove = box(370, 300, 200, 25);
    const textBelow = box(425, 300, 200, 25);

    const placed = chooseBadgePosition(
      target,
      BADGE,
      [textAbove, textBelow],
      [],
      VIEWPORT,
    );

    expect(intersectionArea(placed, textAbove)).toBe(0);
    expect(intersectionArea(placed, textBelow)).toBe(0);
  });

  it("never covers a target's own text -- the descendant case that regressed", () => {
    // The specific bug from the screenshot: when the resolved target is a
    // container (a whole price block) rather than a leaf, its own price text
    // is a descendant. The previous element-hit-testing check exempted
    // descendants of the target outright, so covering the price was allowed.
    // Text rects carry no relationship information, so there is nothing left
    // to exempt.
    const container = box(400, 300, 200, 80);
    const priceTextInsideContainer = box(400, 300, 120, 30);

    const placed = chooseBadgePosition(
      container,
      BADGE,
      [priceTextInsideContainer],
      [],
      VIEWPORT,
    );

    expect(intersectionArea(placed, priceTextInsideContainer)).toBe(0);
  });

  it("keeps a stack of co-located badges from overlapping each other", () => {
    const target = box(400, 300, 200, 40);
    const placedBoxes: Box[] = [];

    for (let i = 0; i < 4; i += 1) {
      placedBoxes.push(chooseBadgePosition(target, BADGE, [], placedBoxes, VIEWPORT));
    }

    for (let i = 0; i < placedBoxes.length; i += 1) {
      for (let j = i + 1; j < placedBoxes.length; j += 1) {
        expect(intersectionArea(placedBoxes[i]!, placedBoxes[j]!)).toBe(0);
      }
    }
  });

  it("keeps the badge inside the viewport for a target at the top edge", () => {
    const target = box(0, 300, 200, 40);
    const placed = chooseBadgePosition(target, BADGE, [], [], VIEWPORT);

    expect(placed.top).toBeGreaterThanOrEqual(0);
    expect(placed.bottom).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it("keeps the badge inside the viewport for a target at the right edge", () => {
    const target = box(400, VIEWPORT.width - 40, 40, 40);
    const placed = chooseBadgePosition(target, BADGE, [], [], VIEWPORT);

    expect(placed.left).toBeGreaterThanOrEqual(0);
    expect(placed.right).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it("picks the least-bad position when every position collides", () => {
    // Saturated cluster: it must still return something on-screen rather than
    // failing to place, and it must prefer the cheapest overlap available.
    const target = box(400, 300, 100, 20);
    const heavy = box(370, 0, VIEWPORT.width, 25); // fully blocks above
    const light = box(425, 300, 30, 25); // clips only a corner below

    const placed = chooseBadgePosition(target, BADGE, [heavy, light], [], VIEWPORT);

    expect(intersectionArea(placed, heavy)).toBe(0);
    expect(positionPenalty(placed, [heavy, light], [])).toBeLessThan(
      positionPenalty(box(370, 300, BADGE.width, BADGE.height), [heavy, light], []),
    );
  });
});

describe("positionPenalty", () => {
  it("is 0 for a clear slot", () => {
    expect(positionPenalty(box(0, 0, 10, 10), [box(100, 100, 10, 10)], [])).toBe(0);
  });

  it("weighs colliding with another badge above covering page text", () => {
    const candidate = box(0, 0, 10, 10);
    const overlap = box(5, 5, 10, 10);

    expect(positionPenalty(candidate, [], [overlap])).toBeGreaterThan(
      positionPenalty(candidate, [overlap], []),
    );
  });
});
