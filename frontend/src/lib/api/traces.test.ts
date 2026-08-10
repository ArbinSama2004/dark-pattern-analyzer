import { describe, expect, it, vi } from "vitest";
import {
  createTraceClient,
  MAX_TRACE_ENTRIES,
  TraceApiError,
  type TraceEntryPayload,
} from "./traces";

function entry(id: string, overrides: Partial<TraceEntryPayload> = {}): TraceEntryPayload {
  return {
    id,
    text: `text ${id}`,
    tag: "span",
    role: "body",
    step: null,
    selector: "",
    ruleHits: [],
    sentToModel: true,
    findingLabels: null,
    firstSeenAt: 0,
    lastSeenAt: 0,
    ...overrides,
  };
}

const REQUEST = {
  scan_id: "scan-1",
  url: "https://www.daraz.com.np/",
  page_score: 40,
  entries: [entry("a")],
};

function okResponse() {
  return new Response(
    JSON.stringify({
      scan_id: "scan-1",
      object_key: "traces/www.daraz.com.np/2026/08/10/scan-1.json",
      bucket: "dp-traces",
      replaced: false,
      entry_count: 1,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("createTraceClient", () => {
  it("posts the trace and returns where it landed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    const client = createTraceClient({ baseUrl: "http://localhost:8000", fetchImpl });

    const result = await client.store(REQUEST);

    expect(result.object_key).toContain("traces/www.daraz.com.np/");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8000/v1/traces",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("truncates rather than letting the backend reject an oversized capture", async () => {
    // A partial trace is worth more than none, and the alternative is a 422
    // that reads as the feature being broken.
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    const client = createTraceClient({ baseUrl: "http://localhost:8000", fetchImpl });

    await client.store({
      ...REQUEST,
      entries: Array.from({ length: MAX_TRACE_ENTRIES + 500 }, (_, i) => entry(String(i))),
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.entries).toHaveLength(MAX_TRACE_ENTRIES);
  });

  it("preserves the three distinct findingLabels states", async () => {
    // null (never resolved), [] (confirmed benign) and non-empty are the whole
    // reason to keep a trace; collapsing any two would make the archive
    // useless for measuring false negatives.
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    const client = createTraceClient({ baseUrl: "http://localhost:8000", fetchImpl });

    await client.store({
      ...REQUEST,
      entries: [
        entry("pending", { findingLabels: null }),
        entry("benign", { findingLabels: [] }),
        entry("flagged", { findingLabels: ["scarcity"] }),
      ],
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.entries[0].findingLabels).toBeNull();
    expect(body.entries[1].findingLabels).toEqual([]);
    expect(body.entries[2].findingLabels).toEqual(["scarcity"]);
  });

  it("surfaces the backend's reason so a disabled archive is distinguishable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ detail: "Trace storage is not enabled" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createTraceClient({ baseUrl: "http://localhost:8000", fetchImpl });

    await expect(client.store(REQUEST)).rejects.toThrow(/not enabled/);
  });

  it("still produces a typed error when the body is not JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("nginx error", { status: 502 }),
    );
    const client = createTraceClient({ baseUrl: "http://localhost:8000", fetchImpl });

    await expect(client.store(REQUEST)).rejects.toBeInstanceOf(TraceApiError);
  });
});
