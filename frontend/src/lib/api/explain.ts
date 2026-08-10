/**
 * Typed client for POST /v1/explain.
 *
 * Mirrors backend/src/app/schemas/explain.py. Like classify.ts, this is called
 * from the background service worker rather than from the page or the side
 * panel directly -- it keeps the API base URL in one place and means the
 * provider's address never appears in a content script.
 *
 * The endpoint explains a finding the classifier already made. There is
 * deliberately no path from its response back into a label, score or page
 * score, and nothing in these types offers one.
 */
import type { Lang } from "../taxonomy";

/** Kept in step with MAX_CONTEXT_SNIPPETS in the backend schema, which
 * rejects anything longer with a 422. Trimming here rather than discovering
 * the cap through a failed request. */
export const MAX_CONTEXT_SNIPPETS = 10;

/** Matches MAX_CONTEXT_CHARS in the backend schema. */
export const MAX_CONTEXT_CHARS = 200;

export interface ExplainContextSnippet {
  text: string;
  tag: string;
  role: string;
}

export interface ExplainRequest {
  text: string;
  label: string;
  tag: string;
  role: string;
  lang: Lang;
  confidence: "possible" | "likely";
  source: ("model" | "rule")[];
  score?: number;
  threshold?: number;
  rule_hits?: string[];
  context?: ExplainContextSnippet[];
  use_cache?: boolean;
}

export interface ExplainResponse {
  explanation: string;
  label: string;
  cached: boolean;
  model: string;
  generation_ms: number;
}

export class ExplainApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** True when the failure is transient (provider down, timeout, rate
     * limited) and the UI should offer a retry rather than a dead end. The
     * backend signals this with 503; 502 means the provider answered
     * unusably and retrying will not help. */
    public retryable: boolean,
  ) {
    super(message);
    this.name = "ExplainApiError";
  }
}

export interface ExplainClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/** Trims context to the backend's limits. A caller assembling neighbours from
 * a page extraction shouldn't have to know the caps -- and a 422 for
 * oversized context would surface to the user as an unexplained failure of a
 * feature that had nothing wrong with it. */
export function prepareContext(
  snippets: ExplainContextSnippet[],
): ExplainContextSnippet[] {
  return snippets
    .filter((s) => s.text.trim().length > 0)
    .slice(0, MAX_CONTEXT_SNIPPETS)
    .map((s) => ({
      ...s,
      text: s.text.slice(0, MAX_CONTEXT_CHARS),
    }));
}

export function createExplainClient({
  baseUrl,
  fetchImpl = fetch,
}: ExplainClientOptions) {
  return {
    async explain(req: ExplainRequest): Promise<ExplainResponse> {
      const res = await fetchImpl(`${baseUrl}/v1/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...req,
          context: prepareContext(req.context ?? []),
        }),
      });

      if (!res.ok) {
        // The backend puts a human-readable reason in `detail` -- surfacing
        // it verbatim is what makes "no API key configured" and "Groq is
        // unreachable" distinguishable in the UI instead of both reading as
        // "explanation failed".
        let detail = "";
        try {
          const body = (await res.json()) as { detail?: string };
          detail = body.detail ?? "";
        } catch {
          detail = await res.text().catch(() => "");
        }
        throw new ExplainApiError(
          detail || `POST /v1/explain failed: ${res.status}`,
          res.status,
          res.status === 503 || res.status === 429,
        );
      }

      return res.json() as Promise<ExplainResponse>;
    },
  };
}
