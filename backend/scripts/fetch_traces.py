"""Download archived traces from MinIO to local files.

    make gold-fetch                      # everything, into ./traces/
    make gold-fetch HOST=daraz.com.np    # one site only
    cd backend && uv run python scripts/fetch_traces.py --out ../traces --host www.daraz.com.np

The archive was write-only until this existed: the extension uploaded captures and
`GET /v1/traces` listed them, but nothing brought the objects back to disk, which
is what `gold_candidates.py` and `trace_report.py` actually consume. This closes
that loop.

Reads the bucket directly rather than the SQLite index. The index is derived data
— it can be deleted, or fall behind a bucket written by another machine — and a
recovery tool should not depend on it. The cost is that `--host` filters on the
key prefix rather than on indexed metadata, which is exactly what the key layout
was designed for (`traces/<host>/<YYYY>/<MM>/<DD>/<scan-id>.json`).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from app.services.object_store import (  # noqa: E402
    ObjectStore,
    ObjectStoreConfig,
    ObjectStoreError,
    safe_segment,
)
from app.settings import get_settings  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Download archived traces from MinIO")
    ap.add_argument("--out", type=Path, default=Path("../traces"))
    ap.add_argument("--host", default=None, help="Only this hostname, e.g. www.daraz.com.np")
    ap.add_argument(
        "--force",
        action="store_true",
        help="Re-download objects already present locally",
    )
    args = ap.parse_args()

    settings = get_settings()
    if not settings.minio_enabled:
        print(
            "Trace storage is disabled. Set DP_MINIO_ENABLED=true in backend/.env\n"
            "and start MinIO with `make minio`.",
            file=sys.stderr,
        )
        return 1

    store = ObjectStore(
        ObjectStoreConfig(
            endpoint=settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            bucket=settings.minio_bucket,
            region=settings.minio_region,
        )
    )

    prefix = f"traces/{safe_segment(args.host)}/" if args.host else "traces/"

    try:
        keys = store.list_keys(prefix)
    except ObjectStoreError as exc:
        print(f"{exc}", file=sys.stderr)
        return 1

    if not keys:
        print(f"No objects under {prefix!r} in bucket {store.bucket!r}.")
        print("Have you pressed 'Save this scan to the archive' in the extension yet?")
        return 0

    args.out.mkdir(parents=True, exist_ok=True)
    written = skipped = failed = 0

    for key in keys:
        # Flatten host and scan id into the filename: the downstream scripts take
        # a flat glob, and a nested YYYY/MM/DD tree would make that awkward for
        # no benefit once the files are on disk.
        parts = key.split("/")
        host = parts[1] if len(parts) > 2 else "unknown"
        name = parts[-1]
        dest = args.out / f"{host}__{name}"

        if dest.exists() and not args.force:
            skipped += 1
            continue
        try:
            dest.write_bytes(store.get_json(key))
            written += 1
        except ObjectStoreError as exc:
            print(f"  failed {key}: {exc}", file=sys.stderr)
            failed += 1

    print(f"bucket    {store.bucket} ({settings.minio_endpoint})")
    print(f"prefix    {prefix}")
    print(f"found     {len(keys)} object(s)")
    print(f"written   {written}")
    if skipped:
        print(f"skipped   {skipped} already present (use --force to overwrite)")
    if failed:
        print(f"failed    {failed}")
    # Resolved, not as given: this script runs inside backend/ but `make` is
    # invoked from the repo root, so a relative path printed here would be wrong
    # wherever the reader is standing.
    resolved = args.out.resolve()
    print(f"into      {resolved}")
    if written or skipped:
        print()
        print(f"Next: make gold-candidates TRACES='{resolved}/*.json'")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
