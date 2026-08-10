/**
 * Typed client for POST /v1/traces.
 *
 * Mirrors backend/src/app/schemas/traces.py. The backend forbids unknown
 * fields on a trace entry rather than ignoring them, so this type drifting
 * from the Python schema produces a loud 422 on the next upload instead of an
 * archive that silently stopped recording a field.
 *
 * Called from the background service worker, like classify and explain, so
 * the API base URL stays in one place.
 */

/** Matches MAX_TRACE_ENTRIES in the backend schema. Trimmed here so an
 * unusually large page produces a truncated capture rather than a rejected
 * one -- a partial trace is worth more than none. */
export const MAX_TRACE_ENTRIES = 5000;

export interface TraceEntryPayload {
  id: string;
  text: string;
  tag: string;
  role: string;
  step: string | null;
  selector: string;
  ruleHits: string[];
  sentToModel: boolean;
  /** null = never resolved, [] = confirmed benign, non-empty = labels found. */
  findingLabels: string[] | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface StoreTraceRequest {
  scan_id: string;
  url: string;
  page_score: number;
  entries: TraceEntryPayload[];
}

export interface StoreTraceResponse {
  scan_id: string;
  object_key: string;
  bucket: string;
  replaced: boolean;
  entry_count: number;
}

export class TraceApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "TraceApiError";
  }
}

export interface TraceClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export function createTraceClient({ baseUrl, fetchImpl = fetch }: TraceClientOptions) {
  return {
    async store(req: StoreTraceRequest): Promise<StoreTraceResponse> {
      const res = await fetchImpl(`${baseUrl}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...req,
          entries: req.entries.slice(0, MAX_TRACE_ENTRIES),
        }),
      });

      if (!res.ok) {
        let detail = "";
        try {
          const body = (await res.json()) as { detail?: string };
          detail = typeof body.detail === "string" ? body.detail : "";
        } catch {
          detail = await res.text().catch(() => "");
        }
        throw new TraceApiError(
          detail || `POST /v1/traces failed: ${res.status}`,
          res.status,
        );
      }

      return res.json() as Promise<StoreTraceResponse>;
    },
  };
}
