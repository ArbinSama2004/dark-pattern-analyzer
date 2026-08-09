# Stage 2 complete -- inference service

What was delivered, what was proven, what you have to run yourself, and where
Stage 3 picks up. This file is the entry point for the next session.

---

## 1. Delivered

```
backend/
  pyproject.toml            dp-backend 0.1.0. fastapi, uvicorn, pydantic,
                            pydantic-settings, onnxruntime, tokenizers, numpy.
                            No torch. No transformers.
  .env.example              every DP_* variable, annotated with the reason
  Dockerfile                serving image, one worker, bundle mounted not baked
  README.md                 how to run it, and what is still unverified
  scripts/smoke_check.py    standalone bundle check, reproduces scarcity=0.626
  src/app/
    main.py                 app factory + lifespan. ONNX session created ONCE
    settings.py             DP_* configuration with validation
    core/                   imports nothing from services/ or api/
      bundle.py             loads and verifies the artifact bundle
      taxonomy.py           the frozen 8 labels + hedged descriptions
      model_input.py        build_model_input -- mirror of ml/src/ml/config.py
      hashing.py            snippet_id and cache_key
      logging.py
    schemas/classify.py     request/response models, extra="forbid"
    services/
      inference.py          the ONLY module importing onnxruntime/tokenizers
      postprocess.py        sigmoid + per-class thresholds. numpy only
      cache.py              TTL + LRU, thread-safe. stdlib only
    api/v1/                 health.py, classify.py, router.py
  tests/                    conftest + 7 test modules
docs/BACKEND.md             design rationale in plain language
docs/PROGRESS.md            Stage 2 section appended
Makefile                    test-backend and smoke-backend added; lint/fmt/test
                            now cover backend/
```

Endpoints: `POST /v1/classify`, `GET /healthz`, `GET /readyz`. Nothing else.
`GET /v1/rules` (late Stage 3) and `POST /v1/feedback` (Stage 4) were **not**
stubbed on purpose.

---

## 2. Decisions made in this stage

| Decision | Reason |
|---|---|
| Startup aborts on a bad bundle; `/readyz` 503s with the reason | A wrong label axis returns 200s and well-formed JSON forever. Same failure shape as the int8 collapse |
| Process still starts on failure rather than crashing | A crash loop gives an operator no message. A live process that refuses readiness is diagnosable in seconds, and it can never serve, because classify also 503s |
| `scarcity=0.626` asserted at startup, tolerance 0.05 | Cheap, and a collapsed graph misses it by ~0.3. Not a replacement for `make parity` |
| Decision logic in numpy/stdlib-only modules | `model.onnx` is gitignored, so CI will never have it. The threshold, multi-label and benign rules must still be tested |
| `snippet_id` and `cache_key` kept separate | Tag and role change the prediction. One shared hash would serve a paragraph's result for the same words on a cancel button |
| In-request dedup of identical model inputs | Product pages repeat the same copy dozens of times. Free, and often halves a batch |
| Padding to the longest row in a batch, not to 64 | p95 token length is 34. This removes a large share of wasted compute |
| ONNX call in a worker thread | `session.run` blocks for 30-60 ms; in the coroutine it would serialise every concurrent request |
| One uvicorn worker | Each worker loads its own ~951 MB graph. Workers multiply memory, not throughput |
| No latency number claimed | The under-100 ms budget assumed int8. It has to be measured on fp32, not assumed |

---

## 3. Verified here, 30 of 30 checks passing

This sandbox has numpy but no network, so `fastapi`, `onnxruntime`, `tokenizers`
and `pytest` could not be installed. The invariant-critical logic was verified with
a stdlib harness instead, and the results are measured, not asserted:

- **Invariant 2:** `build_model_input` byte-identical to `ml/src/ml/config.py`
  across seven cases, including Devanagari, embedded `[TAG=...]` text, tab
  characters and whitespace edges. `ml.LABELS` also confirmed identical to the
  backend's frozen tuple.
- **Invariant 1:** permuted labels, a missing label and a desynced `label_to_id`
  each rejected.
- **Invariant 3:** a missing threshold is never defaulted; unknown profile,
  out-of-range values (0.0, 1.0, -0.2, 1.5) and a string threshold all rejected.
- **Invariant 4:** a model version mismatch is fatal; version, profile, language,
  tag, role and text each change the cache key.
- **Real bundle:** the committed evidence files load and yield exactly the tuned
  vector (confirmshaming 0.11 ... benign 0.17), `dataset=synthetic_v2_1`,
  `quantization=fp32`, inputs `input_ids/attention_mask/token_type_ids`. The
  `recall` profile differs from `precision` in `social_proof` only; `balanced` is
  identical to `precision`.
- **Structural rejections:** missing directory, missing tokenizer, wrong
  `text_column`, malformed JSON, absent graph, and a 1 KB pointer-sized
  `model.onnx`.
- **Postprocess:** stable sigmoid at +/-800 logits, scarcity 0.55 correctly does
  **not** fire against its 0.62 threshold, confirmshaming 0.20 correctly does
  against 0.11, multi-label ordering, all seven firing at once, and benign
  reported without vetoing a dark finding.
- **Cache:** TTL expiry with an injected clock, TTL refresh on overwrite, LRU
  eviction order, `max_entries` respected, and no corruption with 8 threads doing
  1,600 interleaved operations.
- **Schemas:** uppercase DOM tags normalised, roles folded, blank/overlong text,
  unknown language, unknown field and empty snippet list all rejected.

The loader's warnings fired as designed during the run: `false_urgency` carries
`constraint_unmet` at precision 0.793, and the `recall` profile warns that
`social_proof` sits at precision 0.230.

---

## 4. You have to verify these -- they need the bundle

```bash
make install-backend            # cd backend && uv sync
make test-backend               # cd backend && uv run pytest -q
```

Expect the `test_api.py` module to run once `fastapi` and `httpx` are installed,
and `test_bundle.py`'s real-bundle tests to run against the committed metadata.

Then, once `ml/artifacts/model_v1/model.onnx` is in place:

```bash
make smoke-backend              # must print scarcity=0.626
make dev                        # uvicorn on :8000
curl -s localhost:8000/readyz | python -m json.tool
```

`/readyz` must return 200 with `status: ready` and a smoke line reporting
`scarcity=0.626`. **If it 503s, stop.** The message names the cause, and a smoke
failure means the graph is wrong, not that the backend is.

Then measure fp32 latency for real -- a single snippet, a batch of 8, a batch of 32,
a batch of 64 -- and correct the budget in `HANDOFF.md`, which was written assuming
int8. Do not restate under 100 ms as verified.

---

## 5. Stage 1 status update -- the bundle is never actually lost

The earlier assumption (Colab session hit its GPU limit, bundle gone) was wrong.
`model.onnx` was on local disk the whole time at `ml/artifacts/model_v1/`
(951,654,037 bytes, fp32) -- it only looked missing because handoff zips were built
with `git archive`, which omits gitignored files by design. Parity (100.00% /
0.00000) and the smoke check (`scarcity=0.626`) both pass against this file.
`docs/RESULTS.md` section 3 is filled: en 0.8891, hi 0.9054, ne 0.9091.

**No re-run needed. Do not re-run the notebook.**

### Now actually open -- Stage 2 needs real verification

Everything in Section 3 above was checked with a stdlib harness because this sandbox
had no network and couldn't install `fastapi`/`onnxruntime`/`tokenizers`/`pytest`.
None of it has run against the real 951 MB bundle yet:

1. `make install-backend` (`cd backend && uv sync`)
2. `make test-backend` -- expect `test_api.py` and the real-bundle parts of
   `test_bundle.py` to actually execute this time
3. `make smoke-backend` -- must print `scarcity=0.626`
4. `make dev` + `curl -s localhost:8000/readyz` -- expect `status: ready`
5. Measure fp32 latency for real: 1 snippet, batch 8, batch 32, batch 64. Fill
   `docs/RESULTS.md` section 5 and correct `HANDOFF.md`'s latency budget, which was
   written assuming int8. Do not restate "under 100 ms" as verified until measured.

Non-blocking: remove the colliding hard-negative template index 00 in all three
languages from `data/generator/hardneg_templates_a.py`, and append a v2.1 section to
`docs/DATASET_V2.md`. **Do not build a v2.2.**

---

## 6. Stage 3 starts here

The browser extension. The backend contract it consumes is fixed and documented in
`backend/README.md`:

- send `{text, tag, role, lang, ref}` per snippet, at most `DP_MAX_BATCH` per request
- `ref` is opaque and echoed back, so it is how a result maps to a DOM node
- the backend always returns `confidence: "possible"` and `source: ["model"]`

Only the client may promote a finding to `"likely"`, because only the client has
rule hits. The eight client-side detectors and the merge rules are in
`docs/ARCHITECTURE.md`: rule and model together -> `likely`, source
`["rule","model"]`; rule alone -> `likely`; model alone -> `possible`; neither
suppresses the other.

Language discipline holds everywhere it is user-visible: "potentially manipulative
pattern". Never "illegal", "violation" or "fraud". A test asserts none of those words
appear in an API response.
