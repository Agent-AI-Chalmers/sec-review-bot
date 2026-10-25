"""SQLite observation ledger for local/offline memory."""

import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from sec_review_agents.utils.time import utc_now_iso

MEMORY_STATE_FILENAME = "memory_state.sqlite"
MEMORY_STATE_SCHEMA_VERSION = 2

OBSERVATION_STATUS_PENDING = "pending"
OBSERVATION_STATUS_PROCESSED = "processed"
OBSERVATION_STATUSES = {
    OBSERVATION_STATUS_PENDING,
    OBSERVATION_STATUS_PROCESSED,
}

_CURRENT_SCHEMA = """
create table if not exists observations (
  extraction_id text primary key,
  path text not null,
  status text not null,
  created_at text not null,
  updated_at text not null
);
"""
_LEGACY_OBSERVATION_COLUMNS = {
    "observation_id",
    "path",
    "status",
    "created_at",
    "updated_at",
}
_CURRENT_OBSERVATION_COLUMNS = {
    "extraction_id",
    "path",
    "status",
    "created_at",
    "updated_at",
}


@dataclass(frozen=True)
class ObservationRow:
    extraction_id: str
    path: str
    status: str
    created_at: str
    updated_at: str


def initialize_memory_state(memory_store_dir: Path) -> Path:
    state_path = memory_store_dir / MEMORY_STATE_FILENAME
    with sqlite3.connect(state_path) as connection:
        connection.execute("pragma journal_mode=wal")
        columns = {
            str(row[1])
            for row in connection.execute("pragma table_info(observations)").fetchall()
        }
        schema_version = int(connection.execute("pragma user_version").fetchone()[0])

        if schema_version > MEMORY_STATE_SCHEMA_VERSION:
            raise RuntimeError(
                "Local memory state was created by a newer schema version: "
                f"{schema_version} > {MEMORY_STATE_SCHEMA_VERSION}."
            )

        if not columns:
            connection.executescript(_CURRENT_SCHEMA)
        elif columns == _LEGACY_OBSERVATION_COLUMNS and schema_version in {0, 1}:
            connection.execute(
                "alter table observations rename column observation_id to extraction_id"
            )
        elif columns != _CURRENT_OBSERVATION_COLUMNS:
            raise RuntimeError(
                f"Local memory state at {state_path} has an unknown observations schema."
            )

        connection.execute(f"pragma user_version={MEMORY_STATE_SCHEMA_VERSION}")
        connection.commit()
    return state_path


def extraction_id_exists(connection: sqlite3.Connection, extraction_id: str) -> bool:
    row = connection.execute(
        "select 1 from observations where extraction_id = ?",
        (extraction_id,),
    ).fetchone()
    return row is not None


def fetch_observation_by_extraction_id(
    connection: sqlite3.Connection,
    extraction_id: str,
) -> ObservationRow | None:
    row = connection.execute(
        """
        select extraction_id, path, status, created_at, updated_at
        from observations where extraction_id = ?
        """,
        (extraction_id,),
    ).fetchone()
    return None if row is None else ObservationRow(*row)


def upsert_observation(
    connection: sqlite3.Connection,
    *,
    extraction_id: str,
    path: str,
    status: str,
) -> None:
    if status not in OBSERVATION_STATUSES:
        raise ValueError(f"Invalid observation status: {status}")
    now = utc_now_iso()
    if extraction_id_exists(connection, extraction_id):
        connection.execute(
            """
            update observations set path=?, status=?, updated_at=?
            where extraction_id=?
            """,
            (path, status, now, extraction_id),
        )
        return
    connection.execute(
        """
        insert into observations (
          extraction_id, path, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?)
        """,
        (extraction_id, path, status, now, now),
    )


def fetch_observations_by_status(
    connection: sqlite3.Connection,
    *,
    status: str,
    limit: int | None = None,
) -> list[ObservationRow]:
    if status not in OBSERVATION_STATUSES:
        raise ValueError(f"Invalid observation status: {status}")
    if limit is not None and limit < 0:
        raise ValueError("limit must be non-negative")
    limit_clause = f"limit {int(limit)}" if limit is not None else ""
    rows = connection.execute(
        f"""
        select extraction_id, path, status, created_at, updated_at
        from observations where status = ?
        order by created_at asc, extraction_id asc
        {limit_clause}
        """,
        (status,),
    ).fetchall()
    return [ObservationRow(*row) for row in rows]


def fetch_observations_by_extraction_ids(
    connection: sqlite3.Connection,
    *,
    extraction_ids: list[str],
) -> list[ObservationRow]:
    """Fetch existing observations in caller-supplied order."""
    if not extraction_ids:
        return []
    placeholders = ",".join("?" for _ in extraction_ids)
    rows = connection.execute(
        f"""
        select extraction_id, path, status, created_at, updated_at
        from observations where extraction_id in ({placeholders})
        """,
        extraction_ids,
    ).fetchall()
    rows_by_id = {str(row["extraction_id"]): ObservationRow(*row) for row in rows}
    return [
        rows_by_id[extraction_id]
        for extraction_id in extraction_ids
        if extraction_id in rows_by_id
    ]


def mark_observations_processed_if_unchanged(
    connection: sqlite3.Connection,
    *,
    observations: list[ObservationRow],
) -> int:
    processed_count = 0
    now = utc_now_iso()
    for observation in observations:
        cursor = connection.execute(
            """
            update observations set status=?, updated_at=?
            where extraction_id=? and status=? and path=? and updated_at=?
            """,
            (
                OBSERVATION_STATUS_PROCESSED,
                now,
                observation.extraction_id,
                OBSERVATION_STATUS_PENDING,
                observation.path,
                observation.updated_at,
            ),
        )
        processed_count += cursor.rowcount
    return processed_count


def fetch_all_observations(connection: sqlite3.Connection) -> list[ObservationRow]:
    rows = connection.execute("""
        select extraction_id, path, status, created_at, updated_at
        from observations order by created_at asc, extraction_id asc
        """).fetchall()
    return [ObservationRow(*row) for row in rows]


def count_observations_by_status(
    connection: sqlite3.Connection,
    *,
    status: str,
) -> int:
    if status not in OBSERVATION_STATUSES:
        raise ValueError(f"Invalid observation status: {status}")
    row = connection.execute(
        "select count(*) from observations where status = ?",
        (status,),
    ).fetchone()
    return int(row[0])


def oldest_observation_created_at_by_status(
    connection: sqlite3.Connection,
    *,
    status: str,
) -> str | None:
    if status not in OBSERVATION_STATUSES:
        raise ValueError(f"Invalid observation status: {status}")
    row = connection.execute(
        """
        select created_at from observations where status = ?
        order by created_at asc, extraction_id asc limit 1
        """,
        (status,),
    ).fetchone()
    return None if row is None else str(row[0])


@contextmanager
def open_memory_state(memory_store_dir: Path) -> Generator[sqlite3.Connection]:
    connection = sqlite3.connect(memory_store_dir / MEMORY_STATE_FILENAME)
    try:
        connection.row_factory = sqlite3.Row
        yield connection
        connection.commit()
    finally:
        connection.close()
