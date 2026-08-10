import { describe, expect, it, vi } from "vitest";
import {
  createExplainClient,
  ExplainApiError,
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_SNIPPETS,
  prepareContext,
} from "./explain";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const REQUEST = {
  text: "Only 2 left!",
  label: "scarcity",
  tag: "span",
  role: "stock",
  lang: "en" as const,
  confidence: "likely" as const,
  source: ["model" as const, "rule" as const],
};

describe("prepareContext", () => {
  it("caps the number of snippets to what the backend accepts", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      text: `item ${i}`,
      tag: "span",
      role: "body",
    }));

    expect(prepareContext(many)).toHaveLength(MAX_CONTEXT_SNIPPETS);
  });

  it("truncates overlong snippet text", () => {
    const long = [{ text: "x".repeat(1000), tag: "p", role: "body" }];

    expect(prepareContext(long)[0]!.text).toHaveLength(MAX_CONTEXT_CHARS);
  });

  it("drops blank snippets rather than sending them", () => {
    const mixed = [
      { text: "  ", tag: "span", role: "body" },
      { text: "real", tag: "span", role: "body" },
    ];

    expect(prepareContext(mixed)).toEqual([{ text: "real", tag: "span", role: "body" }]);
  });
});

describe("createExplainClient", () => {
  it("returns the explanation on success", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        explanation: "This may be designed to rush you.",
        label: "scarcity",
        cached: false,
        model: "test-model",
        generation_ms: 120,
      }),
    );
    const client = createExplainClient({ baseUrl: "http://localhost:8000", fetchImpl });

    const result = await client.explain(REQUEST);

    expect(result.explanation).toBe("This may be designed to rush you.");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8000/v1/explain",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("trims oversized context before sending, rather than earning a 422", async () => {
    // Typed with the real fetch signature so mock.calls carries the request
    // init argument -- an inferred zero-arg mock types calls as `[]`.
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        explanation: "ok",
        label: "scarcity",
        cached: false,
        model: "m",
        generation_ms: 1,
      }),
    );
    const client = createExplainClient({ baseUrl: "http://localhost:8000", fetchImpl });

    await client.explain({
      ...REQUEST,
      context: Array.from({ length: 30 }, () => ({
        text: "y".repeat(500),
        tag: "span",
        role: "body",
      })),
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.context).toHaveLength(MAX_CONTEXT_SNIPPETS);
    expect(body.context[0].text).toHaveLength(MAX_CONTEXT_CHARS);
  });

  it("surfaces the backend's reason verbatim so failures are distinguishable", async () => {
    // "no API key configured" and "Groq is unreachable" must not both read as
    // a generic failure -- the detail is the only thing that tells them apart.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ detail: "could not reach the model provider. Is it running?" }, 503),
    );
    const client = createExplainClient({ baseUrl: "http://localhost:8000", fetchImpl });

    await expect(client.explain(REQUEST)).rejects.toThrow(/Is it running\?/);
  });

  it("marks a 503 as retryable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "provider down" }, 503));
    const client = createExplainClient({ baseUrl: "http://localhost:8000", fetchImpl });

    await expect(client.explain(REQUEST)).rejects.toMatchObject({ retryable: true });
  });

  it("marks a 502 as not retryable", async () => {
    // The provider answered, but unusably (or its output was rejected by the
    // wording policy). Retrying produces the same result.
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "bad gateway" }, 502));
    const client = createExplainClient({ baseUrl: "http://localhost:8000", fetchImpl });

    await expect(client.explain(REQUEST)).rejects.toMatchObject({ retryable: false });
  });

  it("still produces a usable error when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream exploded", { status: 500 }));
    const client = createExplainClient({ baseUrl: "http://localhost:8000", fetchImpl });

    await expect(client.explain(REQUEST)).rejects.toBeInstanceOf(ExplainApiError);
  });
});
