# Stage 2 -- Inference service

Plain-language record of what the backend does, why it is built this way, and what
was verified. Read `backend/README.md` for how to run it.

---

## What Stage 2 is

A FastAPI service that loads the Stage 1 artifact bundle once at startup and
classifies batches of DOM snippets over HTTP. It is the only consumer of the
bundle, and the bundle is the only thing it shares with `ml/`.

Three endpoints, and no more:

| Endpoint | Purpose |
|---|---|
| `POST /v1/classify` | Batch multi-label classification |
| `GET /healthz` | Liveness. Does not touch the model |
| `GET /readyz` | Readiness. 503 until the bundle loads and the smoke check passes |

`GET /v1/rules` is late Stage 3 and `POST /v1/feedback` is Stage 4. Neither is
stubbed here. A stub returning 501 is a maintenance liability with no user.

---

## The five invariants, and where each is enforced

This is the part that matters. Every invariant has a named enforcement point and a
test that fails if it is removed.

| # | Invariant | Enforced in | Behaviour on violation |
|---|---|---|---|
| 1 | Label order frozen | `core/taxonomy.verify_label_order`, called by `core/bundle.load_bundle` | Startup aborts, `/readyz` 503 |
| 2 | `build_model_input` byte-identical to `ml/` | `core/model_input.py`, guarded by `tests/test_model_input.py` | Test failure |
| 3 | Thresholds only from `thresholds.json` | `core/bundle._load_thresholds` | Startup aborts; a missing class is never defaulted |
| 4 | Model version in every cache key | `core/hashing.cache_key`, cross-checked against the manifest | Startup aborts on version mismatch |
| 5 | No `split_random` headline numbers | Not applicable at serving time | -- |

### Why startup aborts instead of degrading

A service running with a permuted label axis, a stale model version or a
half-defaulted threshold vector looks completely healthy. It returns 200s and
well-formed JSON. Every prediction is wrong and nothing anywhere raises. That is
precisely the failure mode Stage 1's int8 collapse demonstrated, so the design
choice here is the same one the parity test made: fail loudly and early.

The process does still start on failure, and `/readyz` reports exactly why. That is
deliberate. Crashing on boot gives an operator a restart loop and no message. A
live process that refuses readiness and prints the reason is diagnosable in
seconds. It can never serve a prediction in that state, because `/v1/classify` also
returns 503 while the engine is absent.

---

## Request pipeline

1. **Validate and normalise.** The DOM reports `tagName` in uppercase; training
   never saw `"P"`. Tags are lowercased and roles folded to lowercase underscore
   form at the request boundary. Not cosmetic -- it is the difference between the
   model seeing a string shape it was trained on and one it was not.
2. **Build the model input** through `core/model_input.build_model_input`, the only
   place that string is constructed.
3. **Cache lookup.** Key is `dp:v{model_version}:{sha1}`, where the digest covers
   model version, threshold profile, language, tag, role and text.
4. **Dedup within the request.** A product page repeats "Add to cart" many times.
   Collapsing duplicates before the forward pass is free and often halves a batch.
5. **One forward pass**, chunked to `DP_MAX_BATCH`, run in a worker thread.
6. **Threshold and assemble.** Per-class thresholds from the bundle, benign excluded
   from findings, results sorted by descending score.

### Why the two hashes are different

`snippet_id` is `sha1(lang + NUL + text)`, per the Stage 2 contract. It identifies a
piece of page text and deliberately ignores tag and role, so the same sentence keeps
one id wherever it appears.

The cache key cannot work that way. Tag and role change the prediction -- that is the
entire reason `model_input` carries them. Keying the cache on `snippet_id` would
serve a paragraph's prediction for the same words on a cancel button, silently
destroying the structural signal. So there are two hashes, and a test asserts they
stay distinct.

### Why the ONNX call runs in a thread

`session.run` is synchronous and CPU-bound for 30-60 ms on a full batch. Calling it
directly inside the coroutine blocks the event loop for that whole window and
serialises every concurrent request. It runs through `run_in_threadpool` instead.

### Why the session is created once

Creating an `InferenceSession` costs 200-500 ms. Per-request creation is the most
common way to blow a latency budget, so the session is built in the FastAPI
`lifespan` handler and held on `app.state`. A warmup pass runs at startup so the
first user request is not the one paying for graph optimisation.

---

## The startup smoke check

Stage 1's exporter prints `scarcity 0.626` for
`[TAG=span] [ROLE=none] Only 2 left in stock!`. That exact expectation is now
asserted at startup, with a tolerance of 0.05.

This is **not** a replacement for `make parity`. The notebook is explicit that a
smoke test alone cannot detect a destroyed model: int8 collapsed all seven dark
classes to zero positives while the smoke test kept printing plausible
probabilities. The reference value is what makes it useful anyway. A collapsed or
mismatched graph misses 0.626 by roughly 0.3, which the tolerance catches easily,
and it turns "the API started cleanly and labelled every element benign" into a 503
with a readable message.

The bundle loader independently rejects a `model.onnx` smaller than 50 MB, which is
the 0.1 MB dynamo pointer-file trap from Stage 1.

---

## benign is reported, not used as a veto

`benign` is the eighth output and its score is returned for transparency, but the
`benign: true` field in a response means only "no manipulative class cleared its
threshold". It is never a decision input.

Using it as a veto would double-count: the model already traded benign off against
the other seven classes during training with `BCEWithLogitsLoss`. A snippet can
legitimately score high on both benign and scarcity, and when it does, the scarcity
finding stands.

This also keeps the user-facing claim honest. The absence of a detection is not a
positive assertion that a site is behaving well.

---

## Threshold profiles

`precision` is the shipped default. A false positive that accuses an honest site
destroys trust in the extension immediately, which is worth more than the recall it
costs.

`balanced` resolves to an identical vector -- its constraint never binds -- and
`recall` differs from `precision` in exactly one value, `social_proof` 0.46 to 0.08,
which drops that class's validation precision to 0.230. The loader logs a warning
when a profile contains a class under 0.5 precision, and another when a class carries
`constraint_unmet` (which `false_urgency` does, at 0.793 against its 0.80 target).
Both are known and accepted; the point is that an operator switching profiles sees
them.

A per-request `profile` override exists so the Stage 4 evaluation can sweep profiles
without a redeploy. It still reads `thresholds.json` -- there is no code path that
produces a threshold from a literal.

---

## Latency

The budget in `HANDOFF.md` totals under 100 ms, with 30-60 ms for a batch-32
inference. That budget was written while int8 was still assumed. **fp32 MuRIL on CPU
will exceed it**, and the handler logs whenever a request does rather than pretending
otherwise.

No estimate is offered here. The number has to be measured on the target hardware
once the bundle exists, and then the budget in the handoff gets corrected to match
reality. Mitigations already in place, in the order they will actually help:

1. Cache hits cost microseconds, and repeated page copy is the common case.
2. In-request dedup removes duplicate work before the model sees it.
3. Padding is to the longest row in each batch, not to `max_length=64`. Most UI
   microcopy is far under 64 tokens and p95 is 34, so this alone removes a large
   fraction of wasted compute.

If that is still not enough, the real fix is Stage 4 vocabulary pruning, not
quantization. That question is closed.

---

## POST /v1/explain — LLM explanations

Optional, off by default (`DP_LLM_ENABLED`). Turns one **already-made** finding into
a short plain-language explanation. It cannot change a label, a score or the page
score — there is no path from its response back into the pipeline, deliberately: the
fine-tuned classifier stays the source of truth for *what* was detected, and the LLM
is a presentation layer over *why it matters*.

**Provider is Groq**, over its OpenAI-compatible chat-completions endpoint. Nothing
in `services/llm.py` is Groq-specific, so any OpenAI-compatible provider works by
changing `DP_LLM_BASE_URL` and `DP_LLM_MODEL` — but Groq is what is configured and
tested. `DP_LLM_API_KEY` is read on the server and never enters the extension bundle,
which is world-readable to anyone who installs it. That is the reason this is a
backend endpoint at all rather than a direct call from the side panel.

Enabling without a key is a distinct, separately-reported state: the endpoint returns
503 naming the missing key rather than forwarding an unauthenticated request and
surfacing Groq's 401, which reads as a model or network problem instead of a
configuration one.

**On demand, never batched.** One call when a user expands a finding in the side
panel, cached afterwards. Generating explanations at scan time would multiply a page
that already takes 40–80s at 600 candidates, to produce text almost nobody reads.

**Page text is untrusted.** Everything in the request was scraped from a third-party
page, which may contain text written to look like instructions. Page-derived values
are fenced into delimited blocks the system prompt names as untrusted, and
fence-breaking sequences are neutralised before interpolation. This is a mitigation,
not a solved problem — see `services/explain.py`.

**Wording discipline is enforced twice**: once in the system prompt, and once by
rejecting generated text containing legal-claim language (`illegal`, `fraud`,
`violation`, …). A prompt is a request, not a guarantee, and the project's framing
depends on never making that claim. A rejected generation returns 502 and the UI
falls back to the static description, which is always safe.

**Privacy note:** explanations send the flagged text and a handful of neighbouring
page snippets to Groq. Page content therefore leaves the machine whenever a user
clicks "Explain this finding" — that is inherent to a hosted provider, and worth
stating plainly in any demo or write-up.

---

## Deployment notes

One uvicorn worker. Each worker loads its own ~951 MB fp32 graph, so workers
multiply memory rather than throughput. Scale with replicas, and only after
measuring.

The Docker image does not contain the bundle. `model.onnx` is gitignored and far too
large to bake in; mount it read-only and point `DP_MODEL_DIR` at the mount. The image
installs `onnxruntime` and `tokenizers` only -- no torch, no transformers, which is
why the dependency set is separate from `ml/`.

The container healthcheck probes `/readyz`, not `/healthz`, so an unhealthy container
is one that cannot serve rather than one whose process has died.

---

## What is verified, and what is not

Verified without the model, all passing:

- `build_model_input` byte-identical to `ml/src/ml/config.py` across seven cases
  including Devanagari, embedded bracket syntax and whitespace edges
- the real bundle's committed evidence files load and satisfy every contract check
- the exact tuned threshold vector is what gets loaded
- permuted labels, a missing label, a desynced `label_to_id`, a version mismatch, a
  missing threshold, an out-of-range threshold, a non-numeric threshold, a wrong
  `text_column`, a missing tokenizer, malformed JSON, an absent graph and a
  pointer-sized graph are each rejected
- stable sigmoid, per-class thresholds, multi-label, finding order, benign handling
- cache TTL, LRU eviction, stats and thread safety under contention
- request validation and tag/role normalisation

**Not yet verified, because it needs `model.onnx`:** actual inference, the startup
smoke check reproducing 0.626, real latency, and the HTTP tests in
`tests/test_api.py` (they need `fastapi` and `httpx` installed).

Run `make test-backend` after `make install-backend`, then `make smoke-backend` once
the bundle is in place.
