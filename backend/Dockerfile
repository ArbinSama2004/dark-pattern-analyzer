# Serving image. No torch, no transformers -- onnxruntime + tokenizers only.
# The ml/ environment is ~2.5 GB; this one is ~120 MB of wheels plus the model.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# Dependencies first so the layer caches across code changes.
COPY pyproject.toml README.md ./
RUN pip install --upgrade pip && pip install .

COPY src/ ./src/

ENV PYTHONPATH=/srv/src

# The bundle is NOT baked into the image. model.onnx is ~951 MB and gitignored;
# mount it at runtime:
#   docker run -v $(pwd)/../ml/artifacts/model_v1:/models/model_v1:ro \
#     -e DP_MODEL_DIR=/models/model_v1 -p 8000:8000 dp-backend
ENV DP_MODEL_DIR=/models/model_v1

EXPOSE 8000

# Readiness, not liveness: this reports unhealthy until the bundle has loaded and
# the reference smoke check has passed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/readyz').status==200 else 1)"

# Single worker on purpose. Each worker loads its own ~951 MB fp32 graph, so
# workers multiply memory, not throughput. Scale with replicas, and only after
# measuring.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
