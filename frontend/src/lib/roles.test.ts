import { describe, expect, it } from "vitest";
import { ROLES, isRole, assertRole, FALLBACK_ROLE } from "./roles";
import roleData from "./roles.generated.json";

describe("role vocabulary guard", () => {
  it("matches the real training data exactly (20 roles)", () => {
    // Regression test for the invented-vocabulary bug: docs/ARCHITECTURE.md
    // previously specified cancel/accept/optout, none of which exist in
    // data/synthetic/dataset_all.csv. This asserts against the generated
    // mirror of that CSV, not a hand-copied list, so it can't silently drift.
    expect(ROLES).toEqual(roleData.roles);
    expect(ROLES.length).toBe(20);
  });

  it("does not contain any of the previously-invented roles", () => {
    expect(ROLES).not.toContain("cancel");
    expect(ROLES).not.toContain("accept");
    expect(ROLES).not.toContain("optout");
  });

  it("isRole accepts a real role and rejects an invented one", () => {
    expect(isRole("decline")).toBe(true);
    expect(isRole("cancel")).toBe(false);
  });

  it("assertRole throws on an unseen role instead of passing it through", () => {
    expect(() => assertRole("cancel")).toThrow(/Unknown role "cancel"/);
    expect(() => assertRole("decline")).not.toThrow();
  });

  it("FALLBACK_ROLE is itself a valid role", () => {
    expect(isRole(FALLBACK_ROLE)).toBe(true);
  });
});
