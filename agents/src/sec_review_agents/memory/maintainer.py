import asyncio
import fcntl
import shutil
import tempfile
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from sec_review_agents.agents.memory_maintainer.agent import (
    MEMORY_MAINTAINER_AGENT_NAME,
    create_memory_maintainer_agent_graph,
)
from sec_review_agents.agents.memory_maintainer.model import (
    MemoryMaintenanceObservation,
)
from sec_review_agents.agents.memory_maintainer.prompts import (
    MEMORY_MAINTAINER_SYSTEM_PROMPT,
    build_maintenance_prompt,
)
from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_materials,
)
from sec_review_agents.filesystem.material_views import (
    writable_memory_view,
)
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.memory.middleware import (
    DEFAULT_MEMORY_INDEX_MAX_CHARS,
    DEFAULT_MEMORY_INDEX_MAX_LINES,
)
from sec_review_agents.memory.state import (
    OBSERVATION_STATUS_PENDING,
    ObservationRow,
    fetch_observations_by_status,
    mark_observations_processed_if_unchanged,
    open_memory_state,
)
from sec_review_agents.memory.store import (
    initialize_memory_store,
    memory_content_dir,
    memory_observations_dir,
    memory_store_lock,
    resolve_memory_store_dir,
)
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend

MEMORY_MAINTENANCE_LOCK_FILENAME = ".maintenance.lock"
MEMORY_MAINTENANCE_LOCK_POLL_SECONDS = 0.1


@dataclass(frozen=True)
class MemoryMaintenanceResult:
    summary: str
    processed_count: int
    skipped: bool = False


def _memory_index_hygiene_warning(memory_store_dir: Path) -> str | None:
    index_path = memory_content_dir(memory_store_dir) / "MEMORY.md"
    if not index_path.is_file():
        return f"Memory index missing: {index_path}"
    content = index_path.read_text(encoding="utf-8")
    line_count = len(content.splitlines())
    char_count = len(content)
    if (
        line_count <= DEFAULT_MEMORY_INDEX_MAX_LINES
        and char_count <= DEFAULT_MEMORY_INDEX_MAX_CHARS
    ):
        return None
    return (
        "Memory index exceeds startup cap: "
        f"{line_count}/{DEFAULT_MEMORY_INDEX_MAX_LINES} lines, "
        f"{char_count}/{DEFAULT_MEMORY_INDEX_MAX_CHARS} chars. "
        "Keep MEMORY.md as a compact routing index and move details to topics."
    )


def _summary_with_memory_hygiene(memory_store_dir: Path, summary: str) -> str:
    warning = _memory_index_hygiene_warning(memory_store_dir)
    return f"{summary} {warning}" if warning else summary


def _validate_selected_observation_files(
    *,
    memory_store_dir: Path,
    observation_rows: list[ObservationRow],
) -> None:
    """Require selected ledger observations to still have readable bodies."""
    # A ledger row is not maintainable unless its observation body is still present.
    observations_root = memory_observations_dir(memory_store_dir).resolve()
    for row in observation_rows:
        path = Path(row.path).expanduser().resolve()
        try:
            path.relative_to(observations_root)
        except ValueError as error:
            raise ValueError(
                "Pending memory observation path is outside the observations "
                f"directory: {row.observation_id}"
            ) from error
        if not path.is_file():
            raise FileNotFoundError(
                "Pending memory observation file is missing: "
                f"{row.observation_id} ({path})"
            )


def _maintenance_prompt_observations(
    observation_rows: list[ObservationRow],
) -> list[MemoryMaintenanceObservation]:
    return [
        MemoryMaintenanceObservation(
            observation_id=row.observation_id,
            mounted_path=f"/memory/observations/{Path(row.path).name}",
        )
        for row in observation_rows
    ]


def _copy_memory_maintenance_worktree(
    memory_store_dir: Path,
    destination: Path,
) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    content_dir = memory_content_dir(memory_store_dir)
    index_path = content_dir / "MEMORY.md"
    if index_path.is_file():
        shutil.copy2(index_path, destination / "MEMORY.md")
    topics_source = content_dir / "topics"
    topics_destination = destination / "topics"
    if topics_source.is_dir():
        shutil.copytree(topics_source, topics_destination, dirs_exist_ok=True)
    else:
        topics_destination.mkdir(exist_ok=True)
    observations_source = memory_observations_dir(memory_store_dir)
    observations_destination = destination / "observations"
    if observations_source.is_dir():
        shutil.copytree(
            observations_source,
            observations_destination,
            dirs_exist_ok=True,
        )
    else:
        observations_destination.mkdir(exist_ok=True)


def _publish_maintained_memory(*, source: Path, memory_store_dir: Path) -> None:
    content_dir = memory_content_dir(memory_store_dir)
    content_dir.mkdir(exist_ok=True)
    index_source = source / "MEMORY.md"
    if index_source.is_file():
        shutil.copy2(index_source, content_dir / "MEMORY.md")

    topics_source = source / "topics"
    topics_target = content_dir / "topics"
    replacement = Path(tempfile.mkdtemp(prefix=".topics.", dir=content_dir))
    try:
        if topics_source.is_dir():
            shutil.copytree(topics_source, replacement, dirs_exist_ok=True)
        if topics_target.exists():
            shutil.rmtree(topics_target)
        replacement.rename(topics_target)
    finally:
        if replacement.exists():
            shutil.rmtree(replacement)


@asynccontextmanager
async def _maintenance_singleton_lock(memory_store_dir: Path) -> AsyncGenerator[None]:
    """Serialize direct maintenance calls for one memory store."""
    lock_path = memory_store_dir / MEMORY_MAINTENANCE_LOCK_FILENAME
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        while True:
            try:
                # Temporal workflow ids prevent duplicate scheduled maintenance,
                # but direct callers can still race. Without this lock, two
                # processes could select the same pending observations, edit
                # separate worktrees, and let the later publish overwrite the
                # earlier result.
                # Use non-blocking flock in async code: a blocking wait here can
                # stall the event loop while another maintenance run is awaiting.
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                await asyncio.sleep(MEMORY_MAINTENANCE_LOCK_POLL_SECONDS)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


async def maintain_memory_with_result(
    *,
    memory_store_dir: Path | None = None,
    deployment: str | None = None,
    batch_size: int | None = None,
) -> MemoryMaintenanceResult:
    if batch_size is not None and batch_size < 1:
        raise ValueError("batch_size must be positive when provided.")
    memory_store_dir = resolve_memory_store_dir(memory_store_dir, required=True)
    initialize_memory_store(memory_store_dir)

    # Temporal serializes workflow-triggered maintenance. The file lock protects
    # direct cross-process calls to this public helper for the same memory store.
    async with _maintenance_singleton_lock(memory_store_dir):
        return await _maintain_memory_with_result_locked(
            memory_store_dir=memory_store_dir,
            deployment=deployment,
            batch_size=batch_size,
        )


async def _maintain_memory_with_result_locked(
    *,
    memory_store_dir: Path,
    deployment: str | None,
    batch_size: int | None,
) -> MemoryMaintenanceResult:
    selected_rows: list[ObservationRow] = []
    processed_count = 0
    with tempfile.TemporaryDirectory(prefix="sec-review-memory-maintainer-") as tempdir:
        worktree_root = Path(tempdir) / "memory"

        with memory_store_lock(memory_store_dir, exclusive=True):
            with open_memory_state(memory_store_dir) as connection:
                selected_rows = fetch_observations_by_status(
                    connection,
                    status=OBSERVATION_STATUS_PENDING,
                    limit=batch_size,
                )
                if not selected_rows:
                    # No-pending runs are often the only time index bloat is noticed.
                    return MemoryMaintenanceResult(
                        summary=_summary_with_memory_hygiene(
                            memory_store_dir,
                            "No pending memory observations selected.",
                        ),
                        processed_count=0,
                    )
                _validate_selected_observation_files(
                    memory_store_dir=memory_store_dir,
                    observation_rows=selected_rows,
                )
            _copy_memory_maintenance_worktree(memory_store_dir, worktree_root)

        backend = create_backend_with_materials(
            container_name_prefix="memory-maintainer",
            material_views=[
                writable_memory_view(host_path=worktree_root),
            ],
            use_docker_sandbox=False,
        )
        model = create_chat_model(
            agent_name=MEMORY_MAINTAINER_AGENT_NAME,
            deployment_override=deployment,
        )
        async with amanaged_backend(backend):
            agent = await create_memory_maintainer_agent_graph(
                model=model,
                backend=backend,
                worktree_root=worktree_root,
            )
            await invoke_agent_runtime_graph(
                agent=agent,
                agent_name=MEMORY_MAINTAINER_AGENT_NAME,
                system_prompt=MEMORY_MAINTAINER_SYSTEM_PROMPT,
                user_prompt=build_maintenance_prompt(
                    _maintenance_prompt_observations(selected_rows)
                ),
            )

        with memory_store_lock(memory_store_dir, exclusive=True):
            _publish_maintained_memory(
                source=worktree_root,
                memory_store_dir=memory_store_dir,
            )
            with open_memory_state(memory_store_dir) as connection:
                # Only finalize the rows that still match the snapshot reviewed by the LLM.
                processed_count = mark_observations_processed_if_unchanged(
                    connection,
                    observations=selected_rows,
                )

        if not selected_rows:
            return MemoryMaintenanceResult(
                summary=_summary_with_memory_hygiene(
                    memory_store_dir,
                    "No pending memory observations selected.",
                ),
                processed_count=0,
            )

    return MemoryMaintenanceResult(
        summary=_summary_with_memory_hygiene(
            memory_store_dir,
            f"Processed {processed_count} memory observations.",
        ),
        processed_count=processed_count,
    )


__all__ = [
    "MemoryMaintenanceResult",
    "maintain_memory_with_result",
]
