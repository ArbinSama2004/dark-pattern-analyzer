# `backend/` -- Stage 2

**Not yet implemented.** Delivered in Stage 2; see `docs/STAGES.md`.

FastAPI service that loads the Stage 1 artifact bundle and classifies batches of
DOM snippets over HTTP.

## Planned layout

```
backend/
  pyproject.toml        # uv project, src layout
  .env.example
  Dockerfile
  src/app/
    main.py             # app factory; ONNX session created once in lifespan
    settings.py         # pydantic-settings, all env vars typed
    api/v1/             # classify, health
    schemas/            # Pydantic request/response contracts
    core/               # taxonomy, frozen label order, model_input builder
    services/           # inference (ONNX), cache (LRU)
  tests/
```

## Why the dependency set is separate from `ml/`

`ml/` needs `torch` and `transformers` (~2.5 GB). This service needs only
`onnxruntime` and `tokenizers` (~120 MB). Sharing one dependency set would put
PyTorch in the deployed image for no reason.

The backend **never imports from `ml/`**. The only interface between them is the
artifact bundle in `ml/artifacts/model_v1/`.

## Three constraints that matter

1. **Create the ONNX session once**, in the FastAPI `lifespan` handler. Per-request
   creation costs 200-500 ms and is the most common cause of a blown latency budget.
2. **Build the model input string with shared code.** Training consumes
   `[TAG=button] [ROLE=cancel] text`. If serving constructs that string even slightly
   differently, accuracy degrades silently and no test fails. `core/model_input.py`
   owns it, and `tests/test_model_input.py` guards it.
3. **Load thresholds from `thresholds.json`**, never hardcoded. Retraining should
   require no code change -- only a `DP_MODEL_VERSION` bump, which invalidates the
   cache.

## Prerequisite

Stage 1 complete, with the parity test passing. Do not start here until
`ml/artifacts/model_v1/` contains a verified bundle.
