"""SQLite observation ledger for local/offline memory."""

import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from sec_review_agents.utils.time import utc_now_iso

MEMORY_STATE_FILENAME = "memory_state.sqlite"

OBSERVATION_STATUS_PENDING = "pending"
OBSERVATION_STATUS_PROCESSED = "processed"
OBSERVATION_STATUSES = {
    OBSERVATION_STATUS_PENDING,
    OBSERVATION_STATUS_PROCESSED,
}

_SCHEMA = """
create table if not exists observations (
  observation_id text primary key,
  path text not null,
  status text not null,
  created_at text not null,
  updated_at text not null
);
"""


@dataclass(frozen=True)
class ObservationRow:
    observation_id: str
    path: str
    status: str
    created_at: str
    updated_at: str


def initialize_memory_state(memory_store_dir: Path) -> Path:
    state_path = memory_store_dir / MEMORY_STATE_FILENAME
    with sqlite3.connect(state_path) as connection:
        connection.execute("pragma journal_mode=wal")
        connection.executescript(_SCHEMA)
        connection.commit()
    return state_path


def observation_id_exists(connection: sqlite3.Connection, observation_id: str) -> bool:
    row = connection.execute(
        "select 1 from observations where observation_id = ?",
        (observation_id,),
    ).fetchone()
    return row is not None


def fetch_observation_by_id(
    connection: sqlite3.Connection,
    observation_id: str,
) -> ObservationRow | None:
    row = connection.execute(
        """
        select observation_id, path, status, created_at, updated_at
        from observations where observation_id = ?
        """,
        (observation_id,),
    ).fetchone()
    return None if row is None else ObservationRow(*row)


def upsert_observation(
    connection: sqlite3.Connection,
    *,
    observation_id: str,
    path: str,
    status: str,
) -> None:
    if status not in OBSERVATION_STATUSES:
        raise ValueError(f"Invalid observation status: {status}")
    now = utc_now_iso()
    if observation_id_exists(connection, observation_id):
        connection.execute(
            """
            update observations set path=?, status=?, updated_at=?
            where observation_id=?
            """,
            (path, status, now, observation_id),
        )
        return
    connection.execute(
        """
        insert into observations (
          observation_id, path, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?)
        """,
        (observation_id, path, status, now, now),
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
        select observation_id, path, status, created_at, updated_at
        from observations where status = ?
        order by created_at asc, observation_id asc
        {limit_clause}
        """,
        (status,),
    ).fetchall()
    return [ObservationRow(*row) for row in rows]


def fetch_observations_by_ids(
    connection: sqlite3.Connection,
    *,
    observation_ids: list[str],
) -> list[ObservationRow]:
    """Fetch existing observations in caller-supplied order."""
    if not observation_ids:
        return []
    placeholders = ",".join("?" for _ in observation_ids)
    rows = connection.execute(
        f"""
        select observation_id, path, status, created_at, updated_at
        from observations where observation_id in ({placeholders})
        """,
        observation_ids,
    ).fetchall()
    rows_by_id = {str(row["observation_id"]): ObservationRow(*row) for row in rows}
    return [
        rows_by_id[observation_id]
        for observation_id in observation_ids
        if observation_id in rows_by_id
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
            where observation_id=? and status=? and path=? and updated_at=?
            """,
            (
                OBSERVATION_STATUS_PROCESSED,
                now,
                observation.observation_id,
                OBSERVATION_STATUS_PENDING,
                observation.path,
                observation.updated_at,
            ),
        )
        processed_count += cursor.rowcount
    return processed_count


def fetch_all_observations(connection: sqlite3.Connection) -> list[ObservationRow]:
    rows = connection.execute("""
        select observation_id, path, status, created_at, updated_at
        from observations order by created_at asc, observation_id asc
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
        order by created_at asc, observation_id asc limit 1
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
