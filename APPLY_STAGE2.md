# Stage 2 -- what is in this zip and how to apply it

The zip is the **whole repo**, not a patch. `model.onnx` and `.git/` are excluded,
so unzipping over your working copy cannot touch your bundle or your history.

---

## Apply on your Mac (NOT in Colab)

```bash
cd ~/Desktop/dark-pattern-analyzer

# 1. Know what you are about to overwrite. Must be clean or intentionally dirty.
git status

# 2. Unzip over the working copy. -o overwrites without prompting.
unzip -o ~/Downloads/project_stage2.zip -d .

# 3. Confirm the change set matches the manifest below: 3 modified, the rest new.
git status --short

# 4. Commit.
git add -A
git commit -m "feat(backend): Stage 2 inference service, invariants enforced at startup"
git push
```

`unzip` only writes files present in the archive. It never deletes anything, so a
local `ml/artifacts/model_v1/model.onnx`, your `.venv/`, and any local `.env`
survive untouched.

### If step 3 shows unexpected files

`git diff` before committing. The manifest below is exhaustive -- anything outside
it came from your working copy, not from this zip.

---

## Manifest

Verified by diffing this zip against the Stage 1 zip you sent.

### Modified, 3 files

| File | Change |
|---|---|
| `backend/README.md` | "Not yet implemented" replaced with the real API contract, layout, config table and the list of what is still unverified |
| `Makefile` | `test-backend` and `smoke-backend` added; `lint`, `fmt` and `test` now cover `backend/` too |
| `docs/PROGRESS.md` | Stage 2 section appended before "Decisions that will not be revisited" |

### New, 32 files

```
APPLY_STAGE2.md                     this file
STAGE2_COMPLETE.md                  entry point for the next session
docs/BACKEND.md                     design rationale in plain language

backend/pyproject.toml              dp-backend 0.1.0, no torch, no transformers
backend/.env.example                every DP_* variable, annotated
backend/Dockerfile                  serving image, one worker, bundle mounted
backend/scripts/smoke_check.py      standalone bundle check

backend/src/app/__init__.py
backend/src/app/main.py             app factory + lifespan (session created ONCE)
backend/src/app/settings.py         DP_* config with validation
backend/src/app/core/__init__.py
backend/src/app/core/bundle.py      loads and verifies the artifact bundle
backend/src/app/core/taxonomy.py    the frozen 8 labels + hedged descriptions
backend/src/app/core/model_input.py mirror of ml/src/ml/config.py
backend/src/app/core/hashing.py     snippet_id and cache_key
backend/src/app/core/logging.py
backend/src/app/schemas/__init__.py
backend/src/app/schemas/classify.py
backend/src/app/services/__init__.py
backend/src/app/services/inference.py    the ONLY onnxruntime importer
backend/src/app/services/postprocess.py  sigmoid + thresholds, numpy only
backend/src/app/services/cache.py        TTL + LRU, stdlib only
backend/src/app/api/__init__.py
backend/src/app/api/v1/__init__.py
backend/src/app/api/v1/health.py
backend/src/app/api/v1/classify.py
backend/src/app/api/v1/router.py

backend/tests/conftest.py
backend/tests/test_model_input.py   the ml/ drift guard
backend/tests/test_bundle.py
backend/tests/test_hashing.py
backend/tests/test_cache.py
backend/tests/test_postprocess.py
backend/tests/test_schemas.py
backend/tests/test_api.py
```

Nothing under `ml/`, `data/`, or `frontend/` was touched.

---

## Then verify, in this order

```bash
make install-backend        # cd backend && uv sync
make test-backend          # cd backend && uv run pytest -q
```

Tests needing `model.onnx` skip themselves and say so. Everything else must pass.

Once the bundle is at `ml/artifacts/model_v1/`:

```bash
make smoke-backend         # must print scarcity=0.626
make dev                   # uvicorn on :8000
curl -s localhost:8000/readyz | python -m json.tool
```

`/readyz` must return 200 with `status: ready`. **If it returns 503, stop and read
the message** -- it names the cause. A smoke failure means the graph is wrong, not
the backend.

Then measure fp32 latency for real: one snippet, then batches of 8, 32 and 64.
Correct the budget in `HANDOFF.md`, which was written assuming int8.

---

## Local config, which the zip cannot give you

`backend/.env` is intentionally not in the archive. Create it once:

```bash
cd backend && cp .env.example .env
```

The defaults are correct for the standard layout. Only edit `DP_MODEL_DIR` if your
bundle is somewhere other than `../ml/artifacts/model_v1`.
