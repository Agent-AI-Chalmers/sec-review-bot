from pydantic import BaseModel


class DiscoveryEntry(BaseModel):
    """A file admitted by full or incremental discovery's file-selection policy.

    Paths are workspace-relative; metadata describes the file at preparation time.
    Admission does not guarantee a scan: chunk budgeting or a later failed read
    can still move the file into the skipped results.
    """

    path: str
    size_bytes: int
    language: str
    include_reason: str


class DiscoverySkippedFile(BaseModel):
    """Explain why a workspace file did not reach a discovery model call.

    File selection and chunk packing both produce these records. Token estimates
    and their limit are present only for token-budget rejection; ordinary skips
    such as ignored paths or unreadable files have no token accounting.
    """

    path: str
    reason: str
    size_bytes: int
    token_count: int | None = None
    hard_limit_tokens: int | None = None


class DiscoveryChunk(BaseModel):
    """One scheduled model input, prepared from admitted files.

    Entries preserve packing order. The chunk ID associates the scheduled call
    with its artifacts, while token_count estimates the prompt at packing time.
    Source text is read from the workspace for execution, not carried in this
    payload.
    """

    chunk_id: str
    entries: list[DiscoveryEntry]
    token_count: int


class DiscoveryManifest(BaseModel):
    """The preparation result consumed by discovery scheduling and aggregation.

    Discovery owns file selection, packing, and resolved execution limits.
    Workflow and direct runners schedule its chunks without reinterpreting those
    values. Paths refer to worker-local prepared workspace and artifact storage;
    this is an internal activity payload, not a portable repository snapshot.
    """

    workspace_root: str
    discovery_artifacts_path: str
    scan_mode: str
    entries: list[DiscoveryEntry]
    skipped_files: list[DiscoverySkippedFile]
    chunks: list[DiscoveryChunk]
    deployment_input_limit_tokens: int
    chunk_target_tokens: int
    chunk_target_ratio: str
    chunk_hard_limit_tokens: int
    chunk_strategy: str
    max_concurrency: int
