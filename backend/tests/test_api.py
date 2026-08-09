"""HTTP contract tests.

The ONNX graph is gitignored, so these tests substitute a fake engine on
``app.state`` instead of loading a real session. That is not a shortcut for
convenience -- it is the only way the request pipeline (cache keys, in-request
dedup, threshold application, response shape) can be tested in CI at all.

The fake asserts on what the pipeline hands it, so the interesting property being
tested is *how many rows reach the model*, not just the response body.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

fastapi = pytest.importorskip("fastapi", reason="fastapi not installed")
pytest.importorskip("httpx", reason="httpx not installed")

from fastapi.testclient import TestClient  # noqa: E402

from app.core.bundle import load_bundle  # noqa: E402
from app.core.taxonomy import EXPECTED_LABELS  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services.cache import PredictionCache  # noqa: E402
from app.settings import Settings  # noqa: E402
from tests.conftest import write_bundle  # noqa: E402

TUNED = {
    "confirmshaming": 0.11,
    "false_urgency": 0.58,
    "forced_action": 0.43,
    "obstruction": 0.54,
    "scarcity": 0.62,
    "sneaking": 0.48,
    "social_proof": 0.46,
    "benign": 0.17,
}


def _logit(p: float) -> float:
    return math.log(p / (1 - p))


class FakeEngine:
    """Stands in for InferenceEngine. Scores by keyword so tests stay readable."""

    def __init__(self, bundle) -> None:
        self.bundle = bundle
        self.labels = bundle.labels
        self.max_batch = 64
        #: Every batch of model input strings this engine was asked to score.
        self.calls: list[list[str]] = []

    def predict_probs(self, texts: list[str]) -> tuple[np.ndarray, float]:
        self.calls.append(list(texts))
        rows = []
        for text in texts:
            probs = dict.fromkeys(EXPECTED_LABELS, 0.01)
            lowered = text.lower()
            if "left in stock" in lowered or "only" in lowered:
                probs["scarcity"] = 0.93
            if "ends in" in lowered or "hurry" in lowered:
                probs["false_urgency"] = 0.88
            if "no thanks" in lowered:
                probs["confirmshaming"] = 0.20
            if "[role=cta]" in lowered:
                probs["obstruction"] = 0.60
            if not any(v > 0.5 for k, v in probs.items() if k != "benign"):
                probs["benign"] = 0.96
            rows.append([probs[label] for label in EXPECTED_LABELS])
        return np.asarray(rows, dtype=np.float64), 1.23


@pytest.fixture
def client(tmp_path: Path):
    root = write_bundle(tmp_path / "model_v1", thresholds=dict(TUNED))
    settings = Settings(
        model_dir=root,
        model_version="1.0.0",
        threshold_profile="precision",
        max_batch=4,
        cache_ttl=600,
    )
    app = create_app(settings)
    bundle = load_bundle(
        root, profile="precision", expected_version="1.0.0", require_onnx=False
    )
    engine = FakeEngine(bundle)

    with TestClient(app) as test_client:
        # Overwrite whatever lifespan produced (it fails: no model.onnx).
        app.state.engine = engine
        app.state.smoke = None
        app.state.startup_error = None
        app.state.cache = PredictionCache(max_entries=100, ttl_seconds=600)
        app.state.alt_thresholds = {}
        test_client.engine = engine  # type: ignore[attr-defined]
        yield test_client


# --- health ----------------------------------------------------------------


def test_healthz_does_not_depend_on_the_model(tmp_path: Path) -> None:
    app = create_app(Settings(model_dir=tmp_path / "absent", model_version="1.0.0"))
    with TestClient(app) as client:
        response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readyz_is_503_when_the_bundle_is_missing(tmp_path: Path) -> None:
    """A missing model must never present as a healthy service."""
    app = create_app(Settings(model_dir=tmp_path / "absent", model_version="1.0.0"))
    with TestClient(app) as client:
        response = client.get("/readyz")
    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"


def test_readyz_reports_the_loaded_model(client) -> None:
    body = client.get("/readyz").json()
    assert body["status"] == "ready"
    assert body["model"]["model_version"] == "1.0.0"
    assert body["model"]["labels"] == list(EXPECTED_LABELS)


def test_classify_is_503_before_the_model_loads(tmp_path: Path) -> None:
    app = create_app(Settings(model_dir=tmp_path / "absent", model_version="1.0.0"))
    with TestClient(app) as client:
        response = client.post("/v1/classify", json={"snippets": [{"text": "x"}]})
    assert response.status_code == 503


# --- classify happy path ---------------------------------------------------


def test_classify_returns_a_finding(client) -> None:
    response = client.post(
        "/v1/classify",
        json={"snippets": [{"text": "Only 2 left in stock!", "tag": "span", "lang": "en"}]},
    )
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert [f["label"] for f in result["findings"]] == ["scarcity"]
    assert result["benign"] is False
    assert result["findings"][0]["threshold"] == 0.62


def test_findings_are_hedged_and_model_sourced(client) -> None:
    """The backend never emits 'likely' -- it does not run Stage 3's rules."""
    response = client.post("/v1/classify", json={"snippets": [{"text": "Only 2 left in stock!"}]})
    finding = response.json()["results"][0]["findings"][0]
    assert finding["confidence"] == "possible"
    assert finding["source"] == ["model"]
    assert finding["description"]


def test_no_legal_language_anywhere_in_the_response(client) -> None:
    """Ethics constraint: heuristic signals, never legal determinations."""
    response = client.post("/v1/classify", json={"snippets": [{"text": "Only 2 left in stock!"}]})
    body = response.text.lower()
    for banned in ("illegal", "violation", "fraud", "unlawful"):
        assert banned not in body


def test_benign_snippet_has_no_findings(client) -> None:
    response = client.post("/v1/classify", json={"snippets": [{"text": "Free returns within 30 days"}]})
    result = response.json()["results"][0]
    assert result["findings"] == []
    assert result["benign"] is True


def test_multi_label_snippet(client) -> None:
    response = client.post(
        "/v1/classify", json={"snippets": [{"text": "Only 3 left - sale ends in 10:00"}]}
    )
    labels = {f["label"] for f in response.json()["results"][0]["findings"]}
    assert labels == {"scarcity", "false_urgency"}


def test_ref_is_echoed_back(client) -> None:
    response = client.post(
        "/v1/classify", json={"snippets": [{"text": "x", "ref": "node-42"}]}
    )
    assert response.json()["results"][0]["ref"] == "node-42"


def test_results_are_in_request_order(client) -> None:
    response = client.post(
        "/v1/classify",
        json={
            "snippets": [
                {"text": "Free returns", "ref": "a"},
                {"text": "Only 2 left in stock!", "ref": "b"},
            ]
        },
    )
    results = response.json()["results"]
    assert [r["ref"] for r in results] == ["a", "b"]
    assert results[0]["benign"] is True
    assert results[1]["benign"] is False


def test_snippet_id_is_the_documented_hash(client) -> None:
    import hashlib

    response = client.post("/v1/classify", json={"snippets": [{"text": "hello", "lang": "hi"}]})
    expected = hashlib.sha1("hi\u0000hello".encode()).hexdigest()
    assert response.json()["results"][0]["snippet_id"] == expected


def test_scores_are_omitted_unless_requested(client) -> None:
    response = client.post("/v1/classify", json={"snippets": [{"text": "x"}]})
    assert response.json()["results"][0]["scores"] is None


def test_include_all_scores_returns_all_eight(client) -> None:
    response = client.post(
        "/v1/classify", json={"snippets": [{"text": "x"}], "include_all_scores": True}
    )
    scores = response.json()["results"][0]["scores"]
    assert set(scores) == set(EXPECTED_LABELS)


# --- the model input string reaching the model ----------------------------


def test_model_receives_the_prefixed_string(client) -> None:
    client.post(
        "/v1/classify",
        json={"snippets": [{"text": "No thanks", "tag": "BUTTON", "role": "Decline"}]},
    )
    assert client.engine.calls[0] == ["[TAG=button] [ROLE=decline] No thanks"]


# --- dedup and cache -------------------------------------------------------


def test_duplicates_within_a_request_are_deduped(client) -> None:
    """A product page repeats 'Add to cart' many times; score it once."""
    response = client.post(
        "/v1/classify",
        json={"snippets": [{"text": "Add to cart"}] * 4},
    )
    assert len(client.engine.calls[0]) == 1
    assert response.json()["meta"]["inferred"] == 1
    assert len(response.json()["results"]) == 4


def test_same_text_different_role_is_not_a_duplicate(client) -> None:
    """Role is a real signal, so these are two distinct model inputs."""
    client.post(
        "/v1/classify",
        json={
            "snippets": [
                {"text": "No thanks", "role": "none"},
                {"text": "No thanks", "role": "decline"},
            ]
        },
    )
    assert len(client.engine.calls[0]) == 2


def test_second_identical_request_hits_the_cache(client) -> None:
    payload = {"snippets": [{"text": "Only 2 left in stock!"}]}
    first = client.post("/v1/classify", json=payload).json()
    second = client.post("/v1/classify", json=payload).json()
    assert first["meta"]["cache_hits"] == 0
    assert second["meta"]["cache_hits"] == 1
    assert second["meta"]["inferred"] == 0
    assert second["results"][0]["cached"] is True
    assert len(client.engine.calls) == 1


def test_cached_and_fresh_results_agree(client) -> None:
    payload = {"snippets": [{"text": "Only 2 left in stock!"}], "include_all_scores": True}
    first = client.post("/v1/classify", json=payload).json()["results"][0]
    second = client.post("/v1/classify", json=payload).json()["results"][0]
    assert first["findings"] == second["findings"]
    assert first["scores"] == second["scores"]


def test_use_cache_false_bypasses_the_cache(client) -> None:
    payload = {"snippets": [{"text": "Only 2 left in stock!"}], "use_cache": False}
    client.post("/v1/classify", json=payload)
    second = client.post("/v1/classify", json=payload).json()
    assert second["meta"]["cache_hits"] == 0
    assert len(client.engine.calls) == 2


# --- limits and errors -----------------------------------------------------


def test_over_max_batch_is_413(client) -> None:
    response = client.post(
        "/v1/classify", json={"snippets": [{"text": f"item {i}"} for i in range(5)]}
    )
    assert response.status_code == 413
    assert "DP_MAX_BATCH" in response.json()["detail"]


def test_empty_snippets_is_422(client) -> None:
    assert client.post("/v1/classify", json={"snippets": []}).status_code == 422


def test_blank_text_is_422(client) -> None:
    assert client.post("/v1/classify", json={"snippets": [{"text": "  "}]}).status_code == 422


def test_unknown_lang_is_422(client) -> None:
    response = client.post("/v1/classify", json={"snippets": [{"text": "x", "lang": "fr"}]})
    assert response.status_code == 422


def test_unavailable_profile_override_is_400(client) -> None:
    """The synthetic bundle only defines 'precision'."""
    response = client.post(
        "/v1/classify", json={"snippets": [{"text": "x"}], "profile": "balanced"}
    )
    assert response.status_code == 400


# --- meta ------------------------------------------------------------------


def test_meta_reports_provenance(client) -> None:
    meta = client.post("/v1/classify", json={"snippets": [{"text": "x"}]}).json()["meta"]
    assert meta["model_version"] == "1.0.0"
    assert meta["dataset"] == "synthetic_v2_1"
    assert meta["quantization"] == "fp32"
    assert meta["threshold_profile"] == "precision"
    assert meta["snippet_count"] == 1
    assert meta["total_ms"] >= 0


def test_openapi_schema_is_generated(client) -> None:
    assert client.get("/openapi.json").status_code == 200
