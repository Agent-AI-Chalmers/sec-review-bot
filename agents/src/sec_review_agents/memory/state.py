import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sec_review_agents.utils.time import utc_now_iso

MEMORY_STATE_FILENAME = "memory_state.sqlite"

OBSERVATION_STATUS_PENDING = "pending"
OBSERVATION_STATUS_PROCESSED = "processed"

OBSERVATION_STATUSES = {
    OBSERVATION_STATUS_PENDING,
    OBSERVATION_STATUS_PROCESSED,
}

EXTRACTION_JOB_STATUS_PENDING = "pending"
EXTRACTION_JOB_STATUS_RUNNING = "running"
EXTRACTION_JOB_STATUS_PROCESSED = "processed"
EXTRACTION_JOB_STATUS_FAILED = "failed"

EXTRACTION_JOB_STATUSES = {
    EXTRACTION_JOB_STATUS_FAILED,
    EXTRACTION_JOB_STATUS_PENDING,
    EXTRACTION_JOB_STATUS_RUNNING,
    EXTRACTION_JOB_STATUS_PROCESSED,
}

_SCHEMA = """
create table if not exists observations (
  observation_id text primary key,
  path text not null,
  status text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists extraction_jobs (
  job_id text primary key,
  source_workflow text not null,
  run_id text not null,
  artifact_root_path text not null,
  status text not null,
  created_at text not null,
  updated_at text not null
);
"""


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
        select
          observation_id,
          path,
          status,
          created_at,
          updated_at
        from observations
        where observation_id = ?
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
            update observations
            set
              path = ?,
              status = ?,
              updated_at = ?
            where observation_id = ?
            """,
            (path, status, now, observation_id),
        )
    else:
        connection.execute(
            """
            insert into observations (
              observation_id,
              path,
              status,
              created_at,
              updated_at
            ) values (?, ?, ?, ?, ?)
            """,
            (observation_id, path, status, now, now),
        )


def set_observation_status(
    connection: sqlite3.Connection,
    *,
    observation_id: str,
    status: str,
) -> None:
    if status not in OBSERVATION_STATUSES:
        raise ValueError(f"Invalid observation status: {status}")
    now = utc_now_iso()
    connection.execute(
        """
        update observations
        set status = ?, updated_at = ?
        where observation_id = ?
        """,
        (status, now, observation_id),
    )


@dataclass(frozen=True)
class ObservationRow:
    observation_id: str
    path: str
    status: str
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class ExtractionJobRow:
    job_id: str
    source_workflow: str
    run_id: str
    artifact_root_path: str
    status: str
    created_at: str
    updated_at: str


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
        select
          observation_id,
          path,
          status,
          created_at,
          updated_at
        from observations
        where status = ?
        order by created_at asc, observation_id asc
        {limit_clause}
        """,
        (status,),
    ).fetchall()
    return [ObservationRow(*row) for row in rows]


def extraction_job_id_exists(connection: sqlite3.Connection, job_id: str) -> bool:
    row = connection.execute(
        "select 1 from extraction_jobs where job_id = ?",
        (job_id,),
    ).fetchone()
    return row is not None


def fetch_extraction_job_by_id(
    connection: sqlite3.Connection,
    job_id: str,
) -> ExtractionJobRow | None:
    row = connection.execute(
        """
        select
          job_id,
          source_workflow,
          run_id,
          artifact_root_path,
          status,
          created_at,
          updated_at
        from extraction_jobs
        where job_id = ?
        """,
        (job_id,),
    ).fetchone()
    return None if row is None else ExtractionJobRow(*row)


def upsert_extraction_job(
    connection: sqlite3.Connection,
    *,
    job_id: str,
    source_workflow: str,
    run_id: str,
    artifact_root_path: str,
    status: str,
) -> None:
    if status not in EXTRACTION_JOB_STATUSES:
        raise ValueError(f"Invalid extraction job status: {status}")
    now = utc_now_iso()
    if extraction_job_id_exists(connection, job_id):
        connection.execute(
            """
            update extraction_jobs
            set
              source_workflow = ?,
              run_id = ?,
              artifact_root_path = ?,
              status = ?,
              updated_at = ?
            where job_id = ? and status != ?
            """,
            (
                source_workflow,
                run_id,
                artifact_root_path,
                status,
                now,
                job_id,
                EXTRACTION_JOB_STATUS_PROCESSED,
            ),
        )
    else:
        connection.execute(
            """
            insert into extraction_jobs (
              job_id,
              source_workflow,
              run_id,
              artifact_root_path,
              status,
              created_at,
              updated_at
            ) values (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                source_workflow,
                run_id,
                artifact_root_path,
                status,
                now,
                now,
            ),
        )


def register_pending_extraction_job(
    connection: sqlite3.Connection,
    *,
    job_id: str,
    source_workflow: str,
    run_id: str,
    artifact_root_path: str,
) -> bool:
    now = utc_now_iso()
    cursor = connection.execute(
        """
        insert into extraction_jobs (
          job_id,
          source_workflow,
          run_id,
          artifact_root_path,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(job_id) do update set
          source_workflow = excluded.source_workflow,
          run_id = excluded.run_id,
          artifact_root_path = excluded.artifact_root_path,
          updated_at = excluded.updated_at
        where extraction_jobs.status = ?
        """,
        (
            job_id,
            source_workflow,
            run_id,
            artifact_root_path,
            EXTRACTION_JOB_STATUS_PENDING,
            now,
            now,
            EXTRACTION_JOB_STATUS_PENDING,
        ),
    )
    return cursor.rowcount == 1


def fetch_extraction_jobs_by_status(
    connection: sqlite3.Connection,
    *,
    status: str,
    limit: int | None = None,
) -> list[ExtractionJobRow]:
    if status not in EXTRACTION_JOB_STATUSES:
        raise ValueError(f"Invalid extraction job status: {status}")
    if limit is not None and limit < 0:
        raise ValueError("limit must be non-negative")
    limit_clause = f"limit {int(limit)}" if limit is not None else ""
    rows = connection.execute(
        f"""
        select
          job_id,
          source_workflow,
          run_id,
          artifact_root_path,
          status,
          created_at,
          updated_at
        from extraction_jobs
        where status = ?
        order by created_at asc, job_id asc
        {limit_clause}
        """,
        (status,),
    ).fetchall()
    return [ExtractionJobRow(*row) for row in rows]


def claim_pending_extraction_jobs(
    connection: sqlite3.Connection,
    *,
    limit: int,
) -> list[ExtractionJobRow]:
    if limit < 1:
        raise ValueError("limit must be positive")
    now = utc_now_iso()
    rows = connection.execute(
        """
        update extraction_jobs
        set status = ?, updated_at = ?
        where status = ?
          and job_id in (
            select job_id
            from extraction_jobs
            where status = ?
            order by created_at asc, job_id asc
            limit ?
          )
        returning
          job_id,
          source_workflow,
          run_id,
          artifact_root_path,
          status,
          created_at,
          updated_at
        """,
        (
            EXTRACTION_JOB_STATUS_RUNNING,
            now,
            EXTRACTION_JOB_STATUS_PENDING,
            EXTRACTION_JOB_STATUS_PENDING,
            int(limit),
        ),
    ).fetchall()
    return sorted(
        (ExtractionJobRow(*row) for row in rows),
        key=lambda row: (row.created_at, row.job_id),
    )


def fail_stale_running_extraction_jobs(
    connection: sqlite3.Connection,
    *,
    stale_after_seconds: int,
) -> int:
    if stale_after_seconds < 1:
        raise ValueError("stale_after_seconds must be positive")
    cutoff = datetime.now(UTC) - timedelta(seconds=stale_after_seconds)
    now = utc_now_iso()
    cursor = connection.execute(
        """
        update extraction_jobs
        set status = ?, updated_at = ?
        where status = ? and updated_at <= ?
        """,
        (
            EXTRACTION_JOB_STATUS_FAILED,
            now,
            EXTRACTION_JOB_STATUS_RUNNING,
            cutoff.isoformat(),
        ),
    )
    return cursor.rowcount


def is_extraction_job_running(
    connection: sqlite3.Connection,
    *,
    job_id: str,
) -> bool:
    row = connection.execute(
        """
        select 1
        from extraction_jobs
        where job_id = ? and status = ?
        """,
        (job_id, EXTRACTION_JOB_STATUS_RUNNING),
    ).fetchone()
    return row is not None


def mark_running_extraction_job_processed(
    connection: sqlite3.Connection,
    *,
    job_id: str,
) -> bool:
    now = utc_now_iso()
    cursor = connection.execute(
        """
        update extraction_jobs
        set status = ?, updated_at = ?
        where status = ? and job_id = ?
        """,
        (
            EXTRACTION_JOB_STATUS_PROCESSED,
            now,
            EXTRACTION_JOB_STATUS_RUNNING,
            job_id,
        ),
    )
    return cursor.rowcount == 1


def mark_running_extraction_job_failed(
    connection: sqlite3.Connection,
    *,
    job_id: str,
) -> bool:
    now = utc_now_iso()
    cursor = connection.execute(
        """
        update extraction_jobs
        set status = ?, updated_at = ?
        where status = ? and job_id = ?
        """,
        (
            EXTRACTION_JOB_STATUS_FAILED,
            now,
            EXTRACTION_JOB_STATUS_RUNNING,
            job_id,
        ),
    )
    return cursor.rowcount == 1


def fetch_all_extraction_jobs(connection: sqlite3.Connection) -> list[ExtractionJobRow]:
    rows = connection.execute("""
        select
          job_id,
          source_workflow,
          run_id,
          artifact_root_path,
          status,
          created_at,
          updated_at
        from extraction_jobs
        order by created_at asc, job_id asc
        """).fetchall()
    return [ExtractionJobRow(*row) for row in rows]


def mark_observations_processed(
    connection: sqlite3.Connection,
    *,
    observation_ids: list[str],
) -> None:
    for observation_id in observation_ids:
        set_observation_status(
            connection,
            observation_id=observation_id,
            status=OBSERVATION_STATUS_PROCESSED,
        )


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
            update observations
            set status = ?, updated_at = ?
            where observation_id = ?
              and status = ?
              and path = ?
              and updated_at = ?
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
        select
          observation_id,
          path,
          status,
          created_at,
          updated_at
        from observations
        order by created_at asc, observation_id asc
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
        select created_at
        from observations
        where status = ?
        order by created_at asc, observation_id asc
        limit 1
        """,
        (status,),
    ).fetchone()
    return None if row is None else str(row[0])


@contextmanager
def open_memory_state(memory_store_dir: Path) -> Generator[sqlite3.Connection]:
    state_path = memory_store_dir / MEMORY_STATE_FILENAME
    connection = sqlite3.connect(state_path)
    try:
        connection.row_factory = sqlite3.Row
        yield connection
        connection.commit()
    finally:
        connection.close()
