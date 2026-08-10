.DEFAULT_GOAL := help
SHELL := /bin/bash

# ---------------------------------------------------------------------------
# Dark Pattern Analyzer
#
# All four stages are implemented. Targets are grouped by what you are trying
# to do, not by stage number:
#
#   running the thing   -> stack, dev, minio, ext, build-ext
#   training the model  -> model (and its individual steps)
#   checking the work   -> test, lint, smoke-backend, bench
#   evaluating honestly -> gold-candidates, gold-eval, report
# ---------------------------------------------------------------------------

ARTIFACTS ?= ml/artifacts/model_v1
DATA      ?= data/synthetic

.PHONY: help
help: ## Show available targets
	@echo "Dark Pattern Analyzer"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- environment -----------------------------------------------------------

.PHONY: install
install: install-ml install-backend install-frontend ## Install every environment

.PHONY: install-ml
install-ml: ## Install the training environment (torch, transformers, ~2.5 GB)
	cd ml && uv sync

.PHONY: install-backend
install-backend: ## Install the serving environment (onnxruntime, ~120 MB)
	cd backend && uv sync --extra dev

.PHONY: install-frontend
install-frontend: ## Install the extension dependencies
	cd frontend && npm install

# --- running ---------------------------------------------------------------

.PHONY: stack
stack: ## Print how to run the full stack (three terminals; they are long-lived)
	@echo "The full stack is three long-running processes, so run each in its own"
	@echo "terminal rather than backgrounding them from one make target:"
	@echo ""
	@echo "  1. make minio     # only if you want the trace archive"
	@echo "  2. make dev       # backend API on :8000"
	@echo "  3. make ext       # extension dev build, then load frontend/.output/chrome-mv3"
	@echo ""
	@echo "Load unpacked at chrome://extensions, and open a FRESH tab afterwards --"
	@echo "reloading the extension does not replace a content script already"
	@echo "injected into an open tab."

.PHONY: dev
dev: ## Run the backend API with reload on :8000
	cd backend && uv run uvicorn app.main:app --reload --port 8000

.PHONY: minio
minio: ## Start MinIO for the trace archive (console at :9001)
	docker compose up -d minio
	@echo "MinIO S3 API on :9000, console on http://localhost:9001 (minioadmin/minioadmin)"
	@echo "Set DP_MINIO_ENABLED=true in backend/.env and restart the backend."

.PHONY: minio-stop
minio-stop: ## Stop MinIO (keeps stored traces in the docker volume)
	docker compose down

.PHONY: ext
ext: ## Run the extension in dev mode (rebuilds on change)
	cd frontend && npm run dev

.PHONY: build-ext
build-ext: ## Production build of the extension into frontend/.output/
	cd frontend && npm run build

# --- data ------------------------------------------------------------------

.PHONY: data-check
data-check: ## Verify the dataset shape and uniqueness
	cd ml && uv run python -m ml.dataset --check --data ../$(DATA)

.PHONY: data-regen
data-regen: ## Regenerate the synthetic dataset from templates
	cd data/generator && python3 build.py

# --- model (Stage 1) -------------------------------------------------------

.PHONY: fertility
fertility: ## Compare tokenizer fertility across candidate base models
	cd ml && uv run python -m ml.tokenizer_fertility --data ../$(DATA)

.PHONY: baseline
baseline: ## Train the TF-IDF char n-gram + logreg baseline
	cd ml && uv run python -m ml.baseline --data ../$(DATA)

.PHONY: train
train: ## Fine-tune the transformer on the template-disjoint split
	cd ml && uv run python -m ml.train --data ../$(DATA) --out ../$(ARTIFACTS)

.PHONY: thresholds
thresholds: ## Tune per-class decision thresholds on validation
	cd ml && uv run python -m ml.tune_thresholds --artifacts ../$(ARTIFACTS) --data ../$(DATA)

.PHONY: evaluate
evaluate: ## Evaluate: macro-F1, per-class, per-language
	cd ml && uv run python -m ml.evaluate --artifacts ../$(ARTIFACTS) --data ../$(DATA)

.PHONY: export
export: ## Export to ONNX (fp32; int8 failed parity, see docs/RESULTS.md)
	cd ml && uv run python -m ml.export_onnx --artifacts ../$(ARTIFACTS)

.PHONY: parity
parity: ## Assert PyTorch and ONNX agree (catches quantization damage)
	cd ml && uv run python -m ml.parity_test --artifacts ../$(ARTIFACTS) --data ../$(DATA)

.PHONY: model
model: baseline train thresholds evaluate export parity ## Full Stage 1 model pipeline

# --- evaluation (Stage 4) --------------------------------------------------

.PHONY: gold-fetch
gold-fetch: ## Download archived traces from MinIO to ./traces (HOST= to filter)
	cd backend && uv run python scripts/fetch_traces.py --out ../traces $(if $(HOST),--host $(HOST))

.PHONY: gold-candidates
gold-candidates: ## Turn archived traces into an annotation-ready CSV (TRACES=path)
	@test -n "$(TRACES)" || { echo "Usage: make gold-candidates TRACES='path/to/*.json'"; exit 1; }
	cd backend && uv run python scripts/gold_candidates.py $(abspath $(TRACES)) --out ../data/gold/candidates.csv

.PHONY: gold-eval
gold-eval: ## Score the model against the annotated gold set
	@test -f data/gold/gold.csv || { echo "No data/gold/gold.csv yet. See docs/ANNOTATION.md."; exit 1; }
	cd backend && uv run python scripts/gold_eval.py ../data/gold/gold.csv \
		--errors ../data/gold/errors.csv

.PHONY: report
report: ## Markdown report from a trace JSON file (TRACE=path)
	@test -n "$(TRACE)" || { echo "Usage: make report TRACE=path/to/trace.json"; exit 1; }
	cd backend && uv run python scripts/trace_report.py $(abspath $(TRACE))

.PHONY: bench
bench: ## Measure real inference latency against the bundle
	@test -f $(ARTIFACTS)/model.onnx || { echo "No model.onnx in $(ARTIFACTS)."; exit 1; }
	cd backend && uv run python scripts/bench_latency.py

# --- quality ---------------------------------------------------------------

.PHONY: lint
lint: ## Lint and type-check everything
	cd ml && uv run --extra dev ruff check src && uv run --extra dev ruff format --check src
	cd backend && uv run --extra dev ruff check src tests && uv run --extra dev ruff format --check src tests
	cd frontend && npm run compile

.PHONY: fmt
fmt: ## Auto-format
	cd ml && uv run --extra dev ruff format src && uv run --extra dev ruff check --fix src
	cd backend && uv run --extra dev ruff format src tests && uv run --extra dev ruff check --fix src tests

# `ml/` deliberately has no unit-test suite and is not part of this target.
# Its correctness gate is empirical, not example-based: `make parity` asserts
# the exported ONNX graph agrees with PyTorch, and `make evaluate` reports
# macro-F1 on the template-disjoint split. A handful of unit tests over
# training code would not catch what actually goes wrong there (a silently
# damaged graph, a leaky split), and both of those checks do.
.PHONY: test
test: test-backend test-frontend ## Run every test suite (see `parity` for ml/)

.PHONY: test-backend
test-backend: ## Run the backend test suite (skips what needs model.onnx)
	cd backend && uv run pytest -q

.PHONY: test-frontend
test-frontend: ## Run the extension test suite
	cd frontend && npm test

.PHONY: smoke-backend
smoke-backend: ## Load the real bundle and reproduce scarcity=0.626
	@test -f $(ARTIFACTS)/model.onnx || { echo "No model.onnx in $(ARTIFACTS). Run 'make export' first."; exit 1; }
	cd backend && uv run python scripts/smoke_check.py

.PHONY: clean
clean: ## Remove caches and build artifacts (keeps model artifacts)
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type d -name .pytest_cache -prune -exec rm -rf {} +
	rm -rf ml/.ruff_cache backend/.ruff_cache frontend/.output frontend/.wxt
