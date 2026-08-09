import { describe, expect, it } from "vitest";
import { countdownTimer } from "./countdown_timer";
import { makeCandidate } from "./test-helpers";

describe("countdownTimer rule", () => {
  it("fires when is_animated is true", () => {
    const hits = countdownTimer(
      makeCandidate({ text: "00:04:12", is_animated: true }),
      document.body,
    );
    expect(hits).toEqual([{ rule: "countdown_timer", label: "false_urgency" }]);
  });

  it("does not fire on static digits", () => {
    const hits = countdownTimer(
      makeCandidate({ text: "Order by 5pm", is_animated: false }),
      document.body,
    );
    expect(hits).toEqual([]);
  });
});
