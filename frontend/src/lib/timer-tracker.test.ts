import { describe, expect, it, beforeEach, vi } from "vitest";
import { recordObservation, isAnimated, resetTimerTracking } from "./timer-tracker";

beforeEach(() => {
  resetTimerTracking();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

describe("timer-tracker", () => {
  it("is not animated before any observation", () => {
    expect(isAnimated("#t")).toBe(false);
  });

  it("becomes animated after several ~1s-cadence changes", () => {
    recordObservation("#t", "00:10");
    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime(i * 1000);
      recordObservation("#t", `00:${10 - i}`);
    }
    expect(isAnimated("#t")).toBe(true);
  });

  it("does not flag a value that changes far slower than 1s", () => {
    recordObservation("#t", "3 in stock");
    vi.setSystemTime(60_000);
    recordObservation("#t", "2 in stock");
    vi.setSystemTime(120_000);
    recordObservation("#t", "1 in stock");
    expect(isAnimated("#t")).toBe(false);
  });

  it("does not flag text with no digits", () => {
    recordObservation("#t", "Free shipping");
    vi.setSystemTime(1000);
    recordObservation("#t", "Free shipping today");
    expect(isAnimated("#t")).toBe(false);
  });

  it("resets when text stops containing digits", () => {
    recordObservation("#t", "00:10");
    vi.setSystemTime(1000);
    recordObservation("#t", "00:09");
    vi.setSystemTime(2000);
    recordObservation("#t", "Sold out"); // digits disappear -> history clears
    vi.setSystemTime(3000);
    recordObservation("#t", "Sold out!!"); // still no digits
    expect(isAnimated("#t")).toBe(false);
  });
});
