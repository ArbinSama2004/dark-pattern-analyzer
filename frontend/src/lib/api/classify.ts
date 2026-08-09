/**
 * Typed client for POST /v1/classify.
 *
 * IMPORTANT: this mirrors backend/src/app/schemas/classify.py, the actual
 * implemented contract -- not docs/ARCHITECTURE.md's illustrative JSON,
 * which has a different (aspirational) shape (page/items wrapper, richer
 * per-item structural fields, id instead of ref, page_score in the
 * response). Structural signals (visible, font_px, contrast, checked,
 * is_animated, step, selector) are rule-engine-only and never sent to the
 * backend -- only text/tag/role/lang/ref cross the wire.
 */
import type { Lang } from "../taxonomy";

export interface ClassifySnippet {
  text: string;
  tag: string;
  role: string;
  lang: Lang;
  /** Opaque handle echoed back so results map onto DOM nodes without
   * relying on array order. Use the candidate's stable selector or id. */
  ref?: string;
}

export interface ClassifyRequest {
  snippets: ClassifySnippet[];
  profile?: "precision" | "balanced" | "recall";
  use_cache?: boolean;
  include_all_scores?: boolean;
}

export interface Finding {
  label: string;
  score: number;
  threshold: number;
  confidence: "possible" | "likely";
  source: ("model" | "rule")[];
  description: string;
}

export interface SnippetResult {
  snippet_id: string;
  ref: string | null;
  findings: Finding[];
  benign: boolean;
  benign_score: number;
  scores: Record<string, number> | null;
  cached: boolean;
}

export interface ClassifyMeta {
  model_version: string;
  base_model: string;
  dataset: string;
  quantization: string;
  threshold_profile: string;
  snippet_count: number;
  cache_hits: number;
  inferred: number;
  inference_ms: number;
  total_ms: number;
}

export interface ClassifyResponse {
  results: SnippetResult[];
  meta: ClassifyMeta;
}

export class ClassifyApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ClassifyApiError";
  }
}

export interface ClassifyClientOptions {
  baseUrl: string; // e.g. http://localhost:8000 in dev
  fetchImpl?: typeof fetch;
}

export function createClassifyClient({
  baseUrl,
  fetchImpl = fetch,
}: ClassifyClientOptions) {
  return {
    async classify(req: ClassifyRequest): Promise<ClassifyResponse> {
      const res = await fetchImpl(`${baseUrl}/v1/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new ClassifyApiError(
          `POST /v1/classify failed: ${res.status} ${body}`,
          res.status,
        );
      }
      return res.json() as Promise<ClassifyResponse>;
    },

    async ready(): Promise<boolean> {
      try {
        const res = await fetchImpl(`${baseUrl}/readyz`);
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
