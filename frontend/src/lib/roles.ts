/**
 * Typed wrapper around roles.generated.json -- the real 20-role vocabulary
 * the model was fine-tuned on. Never hand-edit the JSON; run
 * `npm run generate:roles` after the dataset changes.
 *
 * Bug this replaces: docs/ARCHITECTURE.md previously specified an invented
 * vocabulary (cancel, accept, optout, banner, label, body). The backend's
 * normalize_role() only lowercases and folds separators -- it does not
 * validate against a known set -- so an invented role would reach the model
 * as an unseen token with no error anywhere: no exception, no 422, just a
 * quietly worse prediction. This file plus the runtime assert below is the
 * validation that was missing.
 */
import generated from "./roles.generated.json";

export const ROLES = generated.roles as readonly string[];

export type Role = (typeof ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);

export function isRole(value: string): value is Role {
  return ROLE_SET.has(value);
}

/** Runtime guard -- if this ever throws, the generated mirror is stale (the
 * dataset changed roles without a regenerate) or a caller is about to send a
 * role the model never saw. Call this at the point a role is decided, not
 * only in tests -- see role.ts. */
export function assertRole(value: string): asserts value is Role {
  if (!ROLE_SET.has(value)) {
    throw new Error(
      `Unknown role "${value}". Expected one of [${ROLES.join(", ")}]. ` +
        `If the dataset legitimately added a new role, run npm run generate:roles.`,
    );
  }
}

/** Safe fallback used by inferRole() when no heuristic matches. Must itself
 * be a valid Role -- guarded by the module-load assert below rather than
 * trusted blindly. */
export const FALLBACK_ROLE: Role = "body" as Role;
assertRole(FALLBACK_ROLE);
