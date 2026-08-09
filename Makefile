.DEFAULT_GOAL := help
SHELL := /bin/bash

# ---------------------------------------------------------------------------
# Dark Pattern Analyzer
# Stage 1: ml/ targets are live. Stage 2/3 targets are declared but not yet
# implemented - they fail with a clear message rather than a confusing error.
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
install: install-ml ## Install everything currently implemented

.PHONY: install-ml
install-ml: ## Install the training environment (torch, transformers)
	cd ml && uv sync

.PHONY: install-backend
install-backend: ## [Stage 2] Install the backend environment
	@test -f backend/pyproject.toml || { echo "Stage 2 not delivered yet."; exit 1; }
	cd backend && uv sync

.PHONY: install-frontend
install-frontend: ## [Stage 3] Install the extension dependencies
	@test -f frontend/package.json || { echo "Stage 3 not delivered yet."; exit 1; }
	cd frontend && pnpm install

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

# --- backend (Stage 2) -----------------------------------------------------

.PHONY: dev
dev: ## [Stage 2] Run the API with reload
	@test -f backend/pyproject.toml || { echo "Stage 2 not delivered yet."; exit 1; }
	cd backend && uv run uvicorn app.main:app --reload --port 8000

# --- frontend (Stage 3) ----------------------------------------------------

.PHONY: ext
ext: ## [Stage 3] Run the extension in dev mode
	@test -f frontend/package.json || { echo "Stage 3 not delivered yet."; exit 1; }
	cd frontend && pnpm dev

# --- quality ---------------------------------------------------------------

.PHONY: lint
lint: ## Lint and type-check everything implemented
	cd ml && uv run ruff check src && uv run ruff format --check src
	cd backend && uv run ruff check src tests && uv run ruff format --check src tests

.PHONY: fmt
fmt: ## Auto-format
	cd ml && uv run ruff format src && uv run ruff check --fix src
	cd backend && uv run ruff format src tests && uv run ruff check --fix src tests

.PHONY: test
test: ## Run tests for everything implemented
	cd ml && uv run pytest -q
	$(MAKE) test-backend

.PHONY: test-backend
test-backend: ## [Stage 2] Run the backend test suite (skips what needs model.onnx)
	@test -f backend/pyproject.toml || { echo "Stage 2 not delivered yet."; exit 1; }
	cd backend && uv run pytest -q

.PHONY: smoke-backend
smoke-backend: ## [Stage 2] Load the real bundle and reproduce scarcity=0.626
	@test -f $(ARTIFACTS)/model.onnx || { echo "No model.onnx in $(ARTIFACTS). Run 'make export' first."; exit 1; }
	cd backend && uv run python scripts/smoke_check.py

.PHONY: clean
clean: ## Remove caches and build artifacts (keeps model artifacts)
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type d -name .pytest_cache -prune -exec rm -rf {} +
	rm -rf ml/.ruff_cache backend/.ruff_cache
