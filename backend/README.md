# `backend/` -- inference service

FastAPI + onnxruntime. Loads the Stage 1 artifact bundle once at startup and
classifies batches of DOM snippets over HTTP.

**Status: Stage 2 implemented.** Inference itself stays unverified until the
bundle exists -- see [What is not verified yet](#what-is-not-verified-yet).

---

## Quick start

```bash
cd backend
uv sync                     # or: pip install -e '.[dev]'
cp .env.example .env        # edit DP_MODEL_DIR if the bundle lives elsewhere
uv run pytest -q            # tests needing the graph skip themselves
uv run uvicorn app.main:app --reload --port 8000
```

From the repo root: `make install-backend`, `make test-backend`, `make dev`.

Check it is actually serving, not merely running:

```bash
curl -s localhost:8000/readyz | python -m json.tool
```

The startup log line that matters is the smoke check:

```
smoke check passed: scarcity=0.626 (expected 0.626 +/- 0.05)
```

If that line says failed, the graph is wrong. Stop and re-run `make parity`.

---

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/classify` | Batch classification, max `DP_MAX_BATCH` snippets |
| GET | `/healthz` | Liveness. Never touches the model |
| GET | `/readyz` | Readiness. 503 until the bundle loads and the smoke check passes |

`GET /v1/rules` is late Stage 3. `POST /v1/feedback` is Stage 4. Neither is
stubbed -- a 501 stub is maintenance with no user.

### POST /v1/classify

```json
{
  "snippets": [
    {"text": "Only 2 left in stock!", "tag": "span", "role": "stock", "lang": "en", "ref": "node-7"}
  ],
  "use_cache": true,
  "include_all_scores": false
}
```

Only `text` is required. `tag` defaults to `span`, `role` to `none`, `lang` to
`en` -- the same defaults training used. `ref` is opaque and echoed back so the
extension can map a result to a DOM node. `profile` optionally overrides the
threshold profile for a single request.

```json
{
  "results": [
    {
      "snippet_id": "9f2c...",
      "ref": "node-7",
      "findings": [
        {
          "label": "scarcity",
          "score": 0.931,
          "threshold": 0.62,
          "confidence": "possible",
          "source": ["model"],
          "description": "Suggests limited availability in a way that may pressure a quick decision."
        }
      ],
      "benign": false,
      "benign_score": 0.041,
      "scores": null,
      "cached": false
    }
  ],
  "meta": {
    "model_version": "1.0.0",
    "threshold_profile": "precision",
    "snippet_count": 1,
    "cache_hits": 0,
    "inferred": 1,
    "inference_ms": 41.2,
    "total_ms": 43.8
  }
}
```

The backend always reports `confidence: "possible"` and `source: ["model"]`. Only
the Stage 3 client, which also has rule hits, may promote a finding to
`"likely"`.

Status codes: 422 invalid snippet, 413 over `DP_MAX_BATCH`, 400 unavailable
threshold profile, 503 model not loaded.

---

## Layout

```
src/app/
  main.py              app factory + lifespan (session created once, here)
  settings.py          DP_* environment configuration
  core/                imports nothing from services/ or api/
    bundle.py          loads and verifies the artifact bundle
    taxonomy.py        the frozen 8 labels and their hedged descriptions
    model_input.py     build_model_input -- mirror of ml/src/ml/config.py
    hashing.py         snippet_id and cache_key
    logging.py
  schemas/classify.py  request/response models
  services/
    inference.py       the only module importing onnxruntime or tokenizers
    postprocess.py     sigmoid + thresholds. numpy only
    cache.py           TTL + LRU. stdlib only
  api/v1/              health.py, classify.py, router.py
scripts/smoke_check.py standalone bundle check
tests/
```

`services/postprocess.py` and `services/cache.py` deliberately avoid
`onnxruntime`, so the decision logic is testable without a 951 MB graph that CI
will never have. Everything importing `onnxruntime` sits behind
`InferenceEngine.__init__`.

**The backend never imports from `ml/`.** The artifact bundle is the only
interface. The single exception is `tests/test_model_input.py`, which loads
`ml/src/ml/config.py` from disk as an isolated module purely to prove the two
copies of `build_model_input` have not drifted.

---

## Configuration

All variables are prefixed `DP_`. See `.env.example` for the annotated list.

| Variable | Default | Notes |
|---|---|---|
| `DP_MODEL_DIR` | `../ml/artifacts/model_v1` | Bundle location |
| `DP_MODEL_VERSION` | `1.0.0` | Must match `manifest.json` or startup aborts |
| `DP_THRESHOLD_PROFILE` | `precision` | `precision`, `balanced` or `recall` |
| `DP_MAX_BATCH` | `64` | Request limit and ONNX chunk size |
| `DP_CACHE_TTL` | `604800` | 7 days |
| `DP_CORS_ORIGINS` | `[]` | Add the extension origin to enable CORS |

---

## Three constraints that are not negotiable

1. **Create the ONNX session once, in `lifespan`.** Session creation costs
   200-500 ms. Per-request creation is the most common way to blow the latency
   budget.
2. **Build the model input with `core/model_input.py` only.** Training consumed
   `[TAG=button] [ROLE=decline] No thanks`. Different spacing or ordering puts the
   model off distribution and quietly costs accuracy with nothing failing.
   `tests/test_model_input.py` guards this.
3. **Load thresholds from `thresholds.json`.** Retraining then needs only a
   `DP_MODEL_VERSION` bump, and the +0.0739 macro-F1 from tuning cannot be handed
   back by an innocent-looking edit.

---

## What is not verified yet

`model.onnx` is roughly 951 MB and gitignored, so it is absent from any fresh
clone. Until it is in place, these are unproven: real inference, the startup
smoke check reproducing `scarcity=0.626`, and actual latency.

The HTTP tests in `tests/test_api.py` substitute a fake engine, so they cover the
request pipeline -- cache keys, dedup, threshold application, response shape --
but not the model.

When the bundle is in place:

```bash
make smoke-backend      # loads the real graph and reproduces 0.626
```

The fp32 latency budget in `HANDOFF.md` was written assuming int8. It has to be
re-measured, not assumed.

Design rationale in plain language: `docs/BACKEND.md`.
