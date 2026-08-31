from math import ceil
from typing import Any


def planning_case_id_batches(
    planning_cases: list[dict[str, Any]], *, max_batch_size: int
) -> list[list[str]]:
    if max_batch_size <= 0:
        raise ValueError("max_batch_size must be positive.")

    cases = [
        case_entry
        for case_entry in planning_cases
        if str(case_entry.get("case_id") or "").strip()
    ]
    if not cases:
        return []

    buckets: dict[str, list[dict[str, Any]]] = {}
    for case_entry in cases:
        buckets.setdefault(_planning_case_primary_path(case_entry), []).append(
            case_entry
        )

    ordered_buckets = [
        sorted(bucket, key=lambda item: str(item.get("case_id") or ""))
        for _, bucket in sorted(buckets.items(), key=lambda item: item[0])
    ]
    ordered_buckets.sort(
        key=lambda bucket: (
            len(bucket) > max_batch_size,
            -len(bucket),
            _planning_case_primary_path(bucket[0]),
        )
    )

    # Batch planning cannot use a naive fixed-size slice: splitting cases that
    # share a primary patch path hides obvious same-surface grouping signals.
    # Keep those related buckets together when possible, then place each bucket
    # into the currently smallest batch so wall-clock work is not dominated by a
    # full batch plus a tiny tail batch.
    batch_count = max(1, ceil(len(cases) / max_batch_size))
    batches: list[list[str]] = [[] for _ in range(batch_count)]
    for bucket in ordered_buckets:
        bucket_case_ids = [str(item.get("case_id") or "").strip() for item in bucket]
        if len(bucket_case_ids) > max_batch_size:
            for chunk in _chunk_case_ids(
                bucket_case_ids, max_batch_size=max_batch_size
            ):
                target_index = _smallest_batch_index(batches)
                if len(batches[target_index]) + len(chunk) > max_batch_size:
                    batches.append([])
                    target_index = len(batches) - 1
                batches[target_index].extend(chunk)
            continue

        target_index = _smallest_batch_index(batches)
        if len(batches[target_index]) + len(bucket_case_ids) > max_batch_size:
            batches.append([])
            target_index = len(batches) - 1
        batches[target_index].extend(bucket_case_ids)

    return [batch for batch in batches if batch]


def _smallest_batch_index(batches: list[list[str]]) -> int:
    return min(range(len(batches)), key=lambda index: (len(batches[index]), index))


def _planning_case_primary_path(case_entry: dict[str, Any]) -> str:
    paths = _planning_case_paths(case_entry)
    if paths:
        return paths[0]
    return f"__no_path__::{str(case_entry.get('case_id') or '').strip()}"


def _planning_case_paths(case_entry: dict[str, Any]) -> list[str]:
    paths: set[str] = set()
    for path in case_entry.get("changed_files") or []:
        if not isinstance(path, str):
            continue
        normalized = _normalized_planning_path(path)
        if normalized:
            paths.add(normalized)
    return sorted(paths)


def _normalized_planning_path(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lstrip("/")
    return normalized or None


def _chunk_case_ids(case_ids: list[str], *, max_batch_size: int) -> list[list[str]]:
    return [
        case_ids[index : index + max_batch_size]
        for index in range(0, len(case_ids), max_batch_size)
    ]


__all__ = ["planning_case_id_batches"]
