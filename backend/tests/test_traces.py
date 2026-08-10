"""Tests for trace archival and the queryable index.

The object store is faked in-process rather than run against a live MinIO. The
behaviour worth testing -- key construction, index upsert semantics, label
querying, write ordering, failure mapping -- is all independent of whether a
real S3 implementation is on the other end, and a suite that only passes when
`docker compose up` happens to be running is a suite that gets skipped.
"""

from __future__ import annotations

from datetime import UTC

import pytest

from app.services.object_store import ObjectStoreError, build_object_key, safe_segment
from app.services.trace_index import TraceIndex, TraceRecord, decode_labels, encode_labels

fastapi = pytest.importorskip("fastapi", reason="fastapi not installed")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402
from app.services.object_store import ObjectStore, ObjectStoreConfig  # noqa: E402
from app.settings import Settings  # noqa: E402

CONFIG = ObjectStoreConfig(
    endpoint="http://localhost:9000",
    access_key="k",
    secret_key="s",
    bucket="dp-traces",
    region="us-east-1",
)


class FakeS3:
    """Enough of the boto3 S3 client for the paths this code exercises."""

    def __init__(self, *, fail_put: bool = False) -> None:
        self.objects: dict[str, bytes] = {}
        self.created_buckets: list[str] = []
        self.fail_put = fail_put

    def head_bucket(self, Bucket: str):  # noqa: N803 - boto3's parameter name
        if Bucket not in self.created_buckets:
            raise RuntimeError("404 not found")

    def create_bucket(self, Bucket: str):  # noqa: N803
        self.created_buckets.append(Bucket)

    def put_object(self, Bucket: str, Key: str, Body: bytes, ContentType: str):  # noqa: N803
        if self.fail_put:
            raise RuntimeError("connection refused")
        self.objects[Key] = Body

    def get_object(self, Bucket: str, Key: str):  # noqa: N803
        if Key not in self.objects:
            raise RuntimeError("404 no such key")

        class _Body:
            def __init__(self, data: bytes) -> None:
                self._data = data

            def read(self) -> bytes:
                return self._data

        return {"Body": _Body(self.objects[Key])}


def make_body(**overrides) -> dict:
    body = {
        "scan_id": "scan-abc",
        "url": "https://www.daraz.com.np/products/thing.html",
        "page_score": 75,
        "entries": [
            {
                "id": "a",
                "text": "Only 2 left in stock!",
                "tag": "span",
                "role": "stock",
                "ruleHits": ["stock_counter"],
                "sentToModel": True,
                "findingLabels": ["scarcity"],
            },
            {
                "id": "b",
                "text": "Add to Cart",
                "tag": "button",
                "role": "cta",
                "sentToModel": True,
                "findingLabels": [],
            },
            {
                "id": "c",
                "text": "Free delivery",
                "tag": "span",
                "role": "body",
                "sentToModel": False,
                "findingLabels": None,
            },
        ],
    }
    body.update(overrides)
    return body


# --- object key construction ----------------------------------------------


class TestObjectKey:
    def test_host_leads_the_key(self):
        # Prefix listing is the only cheap S3 query, and the questions asked of
        # this archive are per-site far more often than per-day.
        key = build_object_key("https://www.daraz.com.np/x", "scan-1")
        assert key.startswith("traces/www.daraz.com.np/")

    def test_key_ends_with_the_scan_id(self):
        assert build_object_key("https://a.com/x", "scan-1").endswith("/scan-1.json")

    def test_same_scan_yields_the_same_key_within_a_day(self):
        # This is what makes a re-upload replace rather than accumulate.
        from datetime import datetime

        moment = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)
        assert build_object_key("https://a.com/x", "s1", moment) == build_object_key(
            "https://a.com/y", "s1", moment
        )

    def test_path_traversal_in_a_host_cannot_escape_the_prefix(self):
        # The host comes from a page-supplied URL and is untrusted in exactly
        # the way page text is.
        key = build_object_key("https://evil.com/x", "../../etc/passwd")
        assert ".." not in key
        assert key.startswith("traces/evil.com/")

    def test_missing_host_does_not_produce_an_empty_segment(self):
        assert "//" not in build_object_key("https:///path", "s1").replace("https://", "")

    def test_safe_segment_rejects_separators(self):
        assert "/" not in safe_segment("a/b/c")
        assert safe_segment("...") == "unknown"


# --- index -----------------------------------------------------------------


class TestLabelEncoding:
    def test_labels_are_comma_wrapped(self):
        assert encode_labels(["scarcity"]) == ",scarcity,"

    def test_empty_stays_empty(self):
        assert encode_labels([]) == ""

    def test_round_trips(self):
        assert decode_labels(encode_labels(["scarcity", "sneaking"])) == [
            "scarcity",
            "sneaking",
        ]

    def test_deduped_and_ordered(self):
        assert encode_labels(["b", "a", "b"]) == ",a,b,"


class TestTraceIndex:
    @pytest.fixture
    def index(self, tmp_path):
        return TraceIndex(tmp_path / "index.db")

    def record(self, **overrides) -> TraceRecord:
        base = dict(
            scan_id="s1",
            object_key="traces/a.com/2026/08/10/s1.json",
            host="a.com",
            url="https://a.com/x",
            captured_at="2026-08-10T12:00:00+00:00",
            candidate_count=10,
            flagged_count=2,
            page_score=50,
            labels=["scarcity"],
        )
        base.update(overrides)
        return TraceRecord(**base)

    def test_upsert_then_get(self, index):
        index.upsert(self.record())
        stored = index.get("s1")
        assert stored is not None
        assert stored.labels == ["scarcity"]

    def test_re_upload_replaces_rather_than_duplicates(self, index):
        index.upsert(self.record(candidate_count=10))
        index.upsert(self.record(candidate_count=99))

        assert index.count() == 1
        assert index.get("s1").candidate_count == 99

    def test_query_by_host(self, index):
        index.upsert(self.record(scan_id="s1", host="a.com"))
        index.upsert(self.record(scan_id="s2", host="b.com"))

        assert [r.scan_id for r in index.query(host="b.com")] == ["s2"]

    def test_query_by_label(self, index):
        index.upsert(self.record(scan_id="s1", labels=["scarcity"]))
        index.upsert(self.record(scan_id="s2", labels=["sneaking"]))

        assert [r.scan_id for r in index.query(label="sneaking")] == ["s2"]

    def test_label_query_does_not_match_a_prefix(self, index):
        # The comma wrapping exists for exactly this: without it,
        # LIKE '%social_proof%' would also match 'social_proof_extra'.
        index.upsert(self.record(scan_id="s1", labels=["social_proof_extra"]))

        assert index.query(label="social_proof") == []

    def test_results_are_newest_first(self, index):
        index.upsert(self.record(scan_id="old", captured_at="2026-01-01T00:00:00+00:00"))
        index.upsert(self.record(scan_id="new", captured_at="2026-08-01T00:00:00+00:00"))

        assert [r.scan_id for r in index.query()] == ["new", "old"]

    def test_survives_reopening(self, tmp_path):
        path = tmp_path / "index.db"
        TraceIndex(path).upsert(self.record())

        assert TraceIndex(path).get("s1") is not None


# --- HTTP route ------------------------------------------------------------


def make_app_client(tmp_path, *, enabled: bool = True, fail_put: bool = False):
    app = create_app(Settings(minio_enabled=False, trace_index_path=tmp_path / "idx.db"))
    client = TestClient(app)
    client.__enter__()
    if enabled:
        fake = FakeS3(fail_put=fail_put)
        app.state.object_store = ObjectStore(CONFIG, client=fake)
        app.state.trace_index = TraceIndex(tmp_path / "idx.db")
        client.fake_s3 = fake  # type: ignore[attr-defined]
    return client


class TestTraceRoute:
    def test_503_when_storage_is_disabled(self, tmp_path):
        client = make_app_client(tmp_path, enabled=False)

        response = client.post("/v1/traces", json=make_body())

        assert response.status_code == 503
        assert "DP_MINIO_ENABLED" in response.json()["detail"]

    def test_stores_the_object_and_indexes_it(self, tmp_path):
        client = make_app_client(tmp_path)

        response = client.post("/v1/traces", json=make_body())

        assert response.status_code == 200
        payload = response.json()
        assert payload["entry_count"] == 3
        assert payload["replaced"] is False
        assert payload["object_key"] in client.fake_s3.objects

    def test_index_records_only_genuinely_flagged_candidates(self, tmp_path):
        # findingLabels: null (never resolved) and [] (confirmed benign) are
        # both "not flagged", and conflating them with a hit would make the
        # archive's own counts untrustworthy.
        client = make_app_client(tmp_path)
        client.post("/v1/traces", json=make_body())

        listed = client.get("/v1/traces").json()["traces"][0]
        assert listed["candidate_count"] == 3
        assert listed["flagged_count"] == 1
        assert listed["labels"] == ["scarcity"]

    def test_re_uploading_the_same_scan_replaces_it(self, tmp_path):
        client = make_app_client(tmp_path)
        client.post("/v1/traces", json=make_body())

        response = client.post("/v1/traces", json=make_body(page_score=90))

        assert response.json()["replaced"] is True
        assert client.get("/v1/traces").json()["total_indexed"] == 1

    def test_query_by_host_and_label(self, tmp_path):
        client = make_app_client(tmp_path)
        client.post("/v1/traces", json=make_body())

        assert client.get("/v1/traces?host=www.daraz.com.np").json()["traces"]
        assert client.get("/v1/traces?label=scarcity").json()["traces"]
        assert client.get("/v1/traces?label=sneaking").json()["traces"] == []
        assert client.get("/v1/traces?host=other.com").json()["traces"] == []

    def test_non_http_urls_are_rejected(self, tmp_path):
        # chrome:// and file:// captures teach nothing and file:// paths leak
        # local directory structure into stored records.
        client = make_app_client(tmp_path)

        response = client.post("/v1/traces", json=make_body(url="file:///Users/me/x.html"))

        assert response.status_code == 422

    def test_unreachable_object_store_is_503_and_indexes_nothing(self, tmp_path):
        # Object first, index second: a failed upload must leave no index row
        # pointing at an object that does not exist.
        client = make_app_client(tmp_path, fail_put=True)

        response = client.post("/v1/traces", json=make_body())

        assert response.status_code == 503
        assert client.get("/v1/traces").json()["total_indexed"] == 0

    def test_oversized_entry_list_is_rejected(self, tmp_path):
        client = make_app_client(tmp_path)
        huge = [{"id": str(i), "text": "x"} for i in range(6000)]

        response = client.post("/v1/traces", json=make_body(entries=huge))

        assert response.status_code == 422

    def test_unknown_entry_fields_are_rejected_rather_than_silently_dropped(self, tmp_path):
        # A field quietly discarded on upload is only discovered much later,
        # when the archive turns out not to contain it.
        client = make_app_client(tmp_path)
        body = make_body()
        body["entries"][0]["somethingNew"] = 1

        assert client.post("/v1/traces", json=body).status_code == 422


class TestObjectStoreErrors:
    def test_put_failure_is_typed_and_retryable(self):
        store = ObjectStore(CONFIG, client=FakeS3(fail_put=True))

        with pytest.raises(ObjectStoreError) as excinfo:
            store.put_json("k", b"{}")

        assert excinfo.value.retryable is True

    def test_bucket_is_created_once(self):
        fake = FakeS3()
        store = ObjectStore(CONFIG, client=fake)

        store.put_json("a", b"{}")
        store.put_json("b", b"{}")

        assert fake.created_buckets == ["dp-traces"]
