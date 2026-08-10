"""S3-compatible object storage for captured traces.

MinIO in development, but nothing here is MinIO-specific: it is the S3 API via
boto3, so the same code addresses real S3 or any compatible store by changing
the endpoint. That is the reason for using boto3 rather than the `minio`
client library -- the dependency is one most deployments already have, and it
does not tie the storage layer to one vendor's SDK.

Failures are typed (ObjectStoreError) rather than leaking botocore exceptions,
so the route layer can map them to status codes without importing botocore.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlparse

log = logging.getLogger(__name__)


class ObjectStoreError(RuntimeError):
    """Any failure to store or retrieve an object."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class ObjectStoreConfig:
    endpoint: str
    access_key: str
    secret_key: str
    bucket: str
    region: str


#: Anything outside this is replaced in a key segment. S3 keys tolerate more,
#: but a key that survives a shell, a URL and a filename without escaping is
#: worth far more than one that maximises expressiveness.
_UNSAFE_KEY_CHARS = re.compile(r"[^a-zA-Z0-9._-]")


def safe_segment(value: str, *, fallback: str = "unknown") -> str:
    """One path segment of an object key, sanitised.

    Guards against traversal (`..`, leading `/`) as well as awkward
    characters: object keys are built partly from a page-supplied host, and a
    host is attacker-influenced data in exactly the same way page text is.
    """
    cleaned = _UNSAFE_KEY_CHARS.sub("-", value).strip("-.")
    return cleaned[:100] or fallback


def build_object_key(url: str, scan_id: str, captured_at: datetime | None = None) -> str:
    """`traces/<host>/<YYYY>/<MM>/<DD>/<scan_id>.json`.

    Host first, then date: the questions actually asked of this archive are
    per-site ("every Daraz capture") far more often than per-day across all
    sites, and S3 listing is prefix-based, so the leading segment decides which
    query is cheap. Date next keeps any one prefix from growing without bound.

    The scan id is the caller's, and stable per page load -- so re-uploading a
    scan that has since resolved more candidates overwrites its earlier, less
    complete object instead of accumulating near-duplicates.
    """
    moment = captured_at or datetime.now(UTC)
    try:
        host = urlparse(url).hostname or "unknown-host"
    except ValueError:
        host = "unknown-host"
    return (
        f"traces/{safe_segment(host, fallback='unknown-host')}/"
        f"{moment:%Y}/{moment:%m}/{moment:%d}/"
        f"{safe_segment(scan_id, fallback='unknown-scan')}.json"
    )


class ObjectStore:
    """Thin put/get over one bucket."""

    def __init__(self, config: ObjectStoreConfig, *, client=None) -> None:
        self._config = config
        self._client = client  # injected in tests; built lazily otherwise
        self._bucket_ready = False

    @property
    def bucket(self) -> str:
        return self._config.bucket

    def _get_client(self):
        if self._client is not None:
            return self._client
        try:
            import boto3
            from botocore.config import Config
        except ImportError as exc:  # pragma: no cover - dependency is declared
            raise ObjectStoreError("boto3 is not installed; trace storage cannot start") from exc

        self._client = boto3.client(
            "s3",
            endpoint_url=self._config.endpoint,
            aws_access_key_id=self._config.access_key,
            aws_secret_access_key=self._config.secret_key,
            region_name=self._config.region,
            # Path-style addressing: MinIO on localhost has no per-bucket DNS,
            # so the virtual-host style boto3 prefers cannot resolve.
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 3}),
        )
        return self._client

    def ensure_bucket(self) -> None:
        """Create the bucket if it does not exist. Idempotent."""
        if self._bucket_ready:
            return
        client = self._get_client()
        try:
            client.head_bucket(Bucket=self._config.bucket)
        except Exception:
            # head_bucket raises for "absent" and for "no permission to look"
            # alike; attempting the create distinguishes them by what it fails
            # with, and succeeds outright in the common first-run case.
            try:
                client.create_bucket(Bucket=self._config.bucket)
                log.info("created bucket %s", self._config.bucket)
            except Exception as exc:  # noqa: BLE001 - re-raised as typed error
                if "BucketAlreadyOwnedByYou" in str(exc) or "BucketAlreadyExists" in str(exc):
                    pass  # raced another worker; fine
                else:
                    raise ObjectStoreError(
                        f"could not create bucket {self._config.bucket!r}: {exc}",
                        retryable=True,
                    ) from exc
        self._bucket_ready = True

    def put_json(self, key: str, body: bytes) -> None:
        self.ensure_bucket()
        try:
            self._get_client().put_object(
                Bucket=self._config.bucket,
                Key=key,
                Body=body,
                ContentType="application/json",
            )
        except ObjectStoreError:
            raise
        except Exception as exc:  # noqa: BLE001 - re-raised as typed error
            raise ObjectStoreError(
                f"could not store object {key!r}: {exc}", retryable=True
            ) from exc

    def get_json(self, key: str) -> bytes:
        try:
            response = self._get_client().get_object(Bucket=self._config.bucket, Key=key)
            return response["Body"].read()
        except Exception as exc:  # noqa: BLE001 - re-raised as typed error
            raise ObjectStoreError(f"could not read object {key!r}: {exc}") from exc

    def list_keys(self, prefix: str = "traces/") -> list[str]:
        """Every object key under ``prefix``, paginated.

        Deliberately reads the bucket rather than the SQLite index: the index is
        derived data that can be deleted or fall behind, and the point of this
        method is to recover traces from the store itself. Prefix listing is the
        one query S3 does cheaply, which is why the key layout puts host first
        (see build_object_key).
        """
        client = self._get_client()
        keys: list[str] = []
        token: str | None = None
        try:
            while True:
                kwargs: dict[str, object] = {"Bucket": self._config.bucket, "Prefix": prefix}
                if token:
                    kwargs["ContinuationToken"] = token
                response = client.list_objects_v2(**kwargs)
                keys.extend(item["Key"] for item in response.get("Contents", []))
                if not response.get("IsTruncated"):
                    break
                token = response.get("NextContinuationToken")
        except Exception as exc:  # noqa: BLE001 - re-raised as typed error
            raise ObjectStoreError(
                f"could not list objects under {prefix!r}: {exc}", retryable=True
            ) from exc
        return keys


__all__ = [
    "ObjectStore",
    "ObjectStoreConfig",
    "ObjectStoreError",
    "build_object_key",
    "safe_segment",
]
