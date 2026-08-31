"""Bubblewrap-backed local sandbox implementation for agent-visible tools."""

# Experimental local-only bwrap backend.
#
# This backend is deliberately opt-in and should not be selected by `auto`.
# Bubblewrap is Linux-specific. It can run inside a WSL2 Linux distribution when
# bwrap and the required namespace policy are available, but it is not a native
# Windows or macOS backend. It also depends on host kernel, user-namespace, and
# LSM/AppArmor policy; on many otherwise normal developer machines those
# policies forbid the namespace setup it needs. Treat this as a host-sensitive
# development execute backend, not the service default and not a replacement
# for the Docker sandbox.
#
# Current experimental scope is intentionally small: filesystem bindings +
# command execution, optional netless mode via bwrap, no loopback configuration,
# no proxying, and no Docker socket exposure.

import asyncio
import os
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from deepagents.backends.protocol import (
    EditResult,
    ExecuteResponse,
    FileData,
    FileDownloadResponse,
    FileUploadResponse,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    SandboxBackendProtocol,
    WriteResult,
)

from sec_review_agents.filesystem.bwrap_runtime import (
    BWRAP_NETWORK_INHERIT,
    BWRAP_NETWORK_NONE,
    BwrapMount,
    arun_bwrap_command,
    basic_bwrap_options,
    default_bwrap_bin,
    run_bwrap_command,
)
from sec_review_agents.filesystem.command_output import (
    combine_command_output,
    text_output,
    truncate_output,
)
from sec_review_agents.filesystem.limits import (
    FilesystemLimits,
    default_filesystem_limits,
)
from sec_review_agents.filesystem.result_parsing import (
    file_infos_from_payload,
    grep_matches_from_payload,
    infer_file_operation_error,
    int_value,
    map_edit_error,
)
from sec_review_agents.filesystem.sandbox_file_ops import (
    bounded_stop_error,
    file_operation_script,
    limits_payload,
    parse_file_operation_output,
)
from sec_review_agents.filesystem.unix_paths import (
    is_absolute_unix_path,
    normalize_glob_pattern,
    normalize_unix_path,
    unix_path_has_prefix,
)
from sec_review_agents.utils.env import env_value, parse_int_env


@dataclass(frozen=True)
class BwrapRoute:
    """Expose a host path at the path the agent sees inside bwrap."""

    host_path: Path | None
    agent_path: str
    writable: bool


class BwrapSandboxBackend(SandboxBackendProtocol):
    def __init__(
        self,
        *,
        routes: list[BwrapRoute],
        working_directory: str = "/workspace",
        shell: str = "/bin/sh",
        bwrap_bin: str | None = None,
        command_timeout_ms: int | None = None,
        network_mode: str | None = None,
        limits: FilesystemLimits | None = None,
    ) -> None:
        self.bwrap_bin = bwrap_bin or default_bwrap_bin()
        self.shell = shell
        self.network_mode = (
            (
                network_mode
                or env_value("AGENT_BWRAP_NETWORK_MODE")
                or BWRAP_NETWORK_INHERIT
            )
            .strip()
            .lower()
        )
        if self.network_mode not in {BWRAP_NETWORK_INHERIT, BWRAP_NETWORK_NONE}:
            raise ValueError("AGENT_BWRAP_NETWORK_MODE must be one of: inherit, none")
        self.working_directory = normalize_unix_path(working_directory)
        self.command_timeout_ms = (
            command_timeout_ms
            if command_timeout_ms is not None
            else parse_int_env(env_value("AGENT_BWRAP_COMMAND_TIMEOUT_MS"))
        )
        self.max_output_bytes = (
            parse_int_env(env_value("AGENT_BWRAP_MAX_OUTPUT_BYTES"), 1024 * 1024)
            or 1024 * 1024
        )
        self.limits = limits or default_filesystem_limits()
        self.routes = tuple(routes)
        self.readable_prefixes = tuple(
            sorted({normalize_unix_path(binding.agent_path) for binding in routes})
        )
        self.writable_prefixes = tuple(
            sorted(
                {
                    normalize_unix_path(binding.agent_path)
                    for binding in routes
                    if binding.writable
                }
            )
        )

    @property
    def id(self) -> str:
        return "bwrap"

    def _bwrap_mounts(self) -> tuple[BwrapMount, ...]:
        mounts: list[BwrapMount] = []
        for binding in self.routes:
            if binding.host_path is None:
                continue
            mounts.append(
                BwrapMount(
                    host_path=binding.host_path,
                    sandbox_path=normalize_unix_path(binding.agent_path),
                    writable=binding.writable,
                )
            )
        return tuple(mounts)

    def sandbox_path_for_agent_path(
        self,
        path: str,
        *,
        require_writable: bool = False,
    ) -> str | None:
        binding = self._binding_for_path(path, require_writable=require_writable)
        if binding is None:
            return None
        return normalize_unix_path(path)

    def stdio_shell_command(self, command: str) -> tuple[str, list[str]]:
        return (
            self.bwrap_bin,
            [
                *basic_bwrap_options(
                    working_directory=self.working_directory,
                    mounts=self._bwrap_mounts(),
                    network_mode=self.network_mode,
                ),
                self.shell,
                "-c",
                command,
            ],
        )

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        effective_timeout = (
            timeout
            if timeout is not None
            else (self.command_timeout_ms / 1000 if self.command_timeout_ms else None)
        )
        try:
            result = run_bwrap_command(
                bwrap_bin=self.bwrap_bin,
                working_directory=self.working_directory,
                mounts=self._bwrap_mounts(),
                shell=self.shell,
                command=command,
                timeout_seconds=effective_timeout,
                network_mode=self.network_mode,
            )
        except subprocess.TimeoutExpired as error:
            output = combine_command_output(
                text_output(error.stdout),
                text_output(error.stderr),
            )
            timeout_desc = (
                f"{effective_timeout:g} seconds"
                if effective_timeout is not None
                else "the configured timeout"
            )
            if output:
                output += "\n"
            output += f"Command timed out after {timeout_desc}."
            truncated_output, truncated = truncate_output(output, self.max_output_bytes)
            return ExecuteResponse(
                output=truncated_output, exit_code=None, truncated=truncated
            )

        output = combine_command_output(result.stdout, result.stderr)
        truncated_output, truncated = truncate_output(output, self.max_output_bytes)
        return ExecuteResponse(
            output=truncated_output,
            exit_code=result.returncode,
            truncated=truncated,
        )

    async def aexecute(
        self,
        command: str,
        *,
        timeout: int | None = None,
    ) -> ExecuteResponse:
        effective_timeout = (
            timeout
            if timeout is not None
            else (self.command_timeout_ms / 1000 if self.command_timeout_ms else None)
        )
        try:
            result = await arun_bwrap_command(
                bwrap_bin=self.bwrap_bin,
                working_directory=self.working_directory,
                mounts=self._bwrap_mounts(),
                shell=self.shell,
                command=command,
                timeout_seconds=effective_timeout,
                network_mode=self.network_mode,
            )
        except subprocess.TimeoutExpired as error:
            output = combine_command_output(
                text_output(error.stdout),
                text_output(error.stderr),
            )
            timeout_desc = (
                f"{effective_timeout:g} seconds"
                if effective_timeout is not None
                else "the configured timeout"
            )
            if output:
                output += "\n"
            output += f"Command timed out after {timeout_desc}."
            truncated_output, truncated = truncate_output(output, self.max_output_bytes)
            return ExecuteResponse(
                output=truncated_output, exit_code=None, truncated=truncated
            )

        output = combine_command_output(result.stdout, result.stderr)
        truncated_output, truncated = truncate_output(output, self.max_output_bytes)
        return ExecuteResponse(
            output=truncated_output,
            exit_code=result.returncode,
            truncated=truncated,
        )

    def _binding_for_path(
        self,
        path: str,
        *,
        require_writable: bool = False,
    ) -> BwrapRoute | None:
        normalized_path = normalize_unix_path(path)
        for binding in sorted(
            self.routes,
            key=lambda item: len(normalize_unix_path(item.agent_path)),
            reverse=True,
        ):
            if not unix_path_has_prefix(normalized_path, binding.agent_path):
                continue
            if require_writable and not binding.writable:
                return None
            return binding
        return None

    def _unresolved_host_path_for_agent_path(
        self,
        path: str,
        *,
        require_writable: bool = False,
    ) -> Path | None:
        binding = self._binding_for_path(path, require_writable=require_writable)
        if binding is None or binding.host_path is None:
            return None
        agent_root = normalize_unix_path(binding.agent_path)
        normalized_path = normalize_unix_path(path)
        relative_path = normalized_path.removeprefix(agent_root).lstrip("/")
        relative_parts = PurePosixPath("/" + relative_path).parts
        if ".." in relative_parts:
            return None
        host_root = binding.host_path.resolve(strict=True)
        return (
            host_root
            if not relative_path
            else host_root.joinpath(*PurePosixPath(relative_path).parts)
        )

    def _safe_existing_host_path_for_agent_path(self, path: str) -> Path | None:
        """Resolve an existing agent path to a host path within its mount."""
        # Host-side transfers do not pass through bwrap, so the backend must
        # enforce the same mount boundary before opening local files.
        host_path = self._unresolved_host_path_for_agent_path(path)
        if host_path is None:
            return None
        try:
            resolved_path = host_path.resolve(strict=True)
            binding = self._binding_for_path(path)
            if binding is None or binding.host_path is None:
                return None
            host_root = binding.host_path.resolve(strict=True)
            if resolved_path != host_root and host_root not in resolved_path.parents:
                return None
            if host_path.is_symlink():
                return None
            return host_path
        except OSError:
            return None

    def _safe_writable_host_path_for_agent_path(self, path: str) -> Path | None:
        host_path = self._unresolved_host_path_for_agent_path(
            path, require_writable=True
        )
        if host_path is None:
            return None
        try:
            binding = self._binding_for_path(path, require_writable=True)
            if binding is None or binding.host_path is None:
                return None
            host_root = binding.host_path.resolve(strict=True)
            relative_path = host_path.relative_to(host_root)
            current_path = host_root
            # New directories may be created inside the mount root, but existing
            # path components must not be symlinks that redirect writes outside it.
            for part in relative_path.parts[:-1]:
                current_path = current_path / part
                if not current_path.exists():
                    continue
                if current_path.is_symlink() or not current_path.is_dir():
                    return None
            if host_path.exists() or host_path.is_symlink():
                resolved_path = host_path.resolve(strict=True)
                if (
                    resolved_path != host_root
                    and host_root not in resolved_path.parents
                ):
                    return None
                if host_path.is_symlink():
                    return None
            return host_path
        except OSError:
            return None

    def _is_allowed_path(self, path: str, *, writable: bool = False) -> bool:
        if not is_absolute_unix_path(path):
            return False
        return self._binding_for_path(path, require_writable=writable) is not None

    def _path_access_error(self, path: str, *, writable: bool = False) -> str:
        access = "write" if writable else "read"
        return f"Path '{path}' is outside the bwrap sandbox {access} roots"

    def _run_file_operation(self, payload: dict[str, object]) -> dict[str, object]:
        script = file_operation_script(payload)
        result = self.execute(f"python3 -c {shlex.quote(script)}")
        if result.truncated:
            return {"error": "file operation output was truncated"}
        return parse_file_operation_output(result.output)

    async def _arun_file_operation(
        self,
        payload: dict[str, object],
    ) -> dict[str, object]:
        script = file_operation_script(payload)
        result = await self.aexecute(f"python3 -c {shlex.quote(script)}")
        if result.truncated:
            return {"error": "file operation output was truncated"}
        return parse_file_operation_output(result.output)

    def _limits_payload(
        self, *, grep_max_count: int | None = None
    ) -> dict[str, object]:
        return limits_payload(self.limits, grep_max_count=grep_max_count)

    def ls(self, path: str) -> LsResult:
        if not self._is_allowed_path(path):
            return LsResult(error=self._path_access_error(path), entries=None)
        data = self._run_file_operation(
            {"op": "ls", "path": path, "limits": self._limits_payload()}
        )
        return self._ls_result(path, data)

    def _ls_result(self, path: str, data: dict[str, object]) -> LsResult:
        error = data.get("error")
        if error == "entry_limit":
            return LsResult(
                error=bounded_stop_error(
                    operation="ls",
                    stop_reason="entry_limit",
                    limits=self.limits,
                ),
                entries=file_infos_from_payload(data.get("entries")),
            )
        if error:
            return LsResult(error=f"Error listing path '{path}': {error}", entries=None)
        return LsResult(entries=file_infos_from_payload(data.get("entries")))

    async def als(self, path: str) -> LsResult:
        if not self._is_allowed_path(path):
            return LsResult(error=self._path_access_error(path), entries=None)
        data = await self._arun_file_operation(
            {"op": "ls", "path": path, "limits": self._limits_payload()}
        )
        return self._ls_result(path, data)

    def read(
        self,
        file_path: str,
        offset: int = 0,
        limit: int = 2000,
    ) -> ReadResult:
        if not self._is_allowed_path(file_path):
            return ReadResult(error=self._path_access_error(file_path))
        data = self._run_file_operation(
            {
                "op": "read",
                "path": file_path,
                "offset": offset,
                "limit": limit,
                "limits": self._limits_payload(),
            }
        )
        return self._read_result(file_path, offset, data)

    def _read_result(
        self,
        file_path: str,
        offset: int,
        data: dict[str, object],
    ) -> ReadResult:
        error = data.get("error")
        if error == "read_max_bytes":
            return ReadResult(
                error=f"File '{file_path}' exceeds read limit ({data.get('size')} bytes)"
            )
        if error == "read_max_scan_bytes":
            return ReadResult(error=f"File '{file_path}' exceeded read scan budget")
        if error == "file_not_found":
            return ReadResult(error=f"File '{file_path}' not found")
        if error == "offset_exceeds_length":
            return ReadResult(
                error=(
                    f"Line offset {offset} exceeds file length "
                    f"({data.get('line_count')} lines)"
                )
            )
        if error:
            return ReadResult(error=str(error))
        file_data: FileData = {
            "content": str(data.get("content", "")),
            "encoding": str(data.get("encoding", "utf-8")),
        }
        return ReadResult(file_data=file_data)

    async def aread(
        self,
        file_path: str,
        offset: int = 0,
        limit: int = 2000,
    ) -> ReadResult:
        if not self._is_allowed_path(file_path):
            return ReadResult(error=self._path_access_error(file_path))
        data = await self._arun_file_operation(
            {
                "op": "read",
                "path": file_path,
                "offset": offset,
                "limit": limit,
                "limits": self._limits_payload(),
            }
        )
        return self._read_result(file_path, offset, data)

    def grep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        search_path = path or "/"
        if not self._is_allowed_path(search_path):
            return GrepResult(error=self._path_access_error(search_path), matches=[])
        data = self._run_file_operation(
            {
                "op": "grep",
                "path": search_path,
                "pattern": pattern,
                "glob": normalize_glob_pattern(glob or "**/*"),
                "limits": self._limits_payload(grep_max_count=max_count),
            }
        )
        return self._grep_result(search_path, data, max_count=max_count)

    def _grep_result(
        self,
        search_path: str,
        data: dict[str, object],
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        error = data.get("error")
        if error:
            return GrepResult(
                error=f"Error searching path '{search_path}': {error}",
                matches=[],
            )
        return GrepResult(
            error=bounded_stop_error(
                operation="grep",
                stop_reason=data.get("stop_reason"),
                limits=self.limits,
                grep_max_count=max_count,
            ),
            matches=grep_matches_from_payload(data.get("matches")),
            truncated=data.get("stop_reason") is not None,
        )

    async def agrep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        search_path = path or "/"
        if not self._is_allowed_path(search_path):
            return GrepResult(error=self._path_access_error(search_path), matches=[])
        data = await self._arun_file_operation(
            {
                "op": "grep",
                "path": search_path,
                "pattern": pattern,
                "glob": normalize_glob_pattern(glob or "**/*"),
                "limits": self._limits_payload(grep_max_count=max_count),
            }
        )
        return self._grep_result(search_path, data, max_count=max_count)

    def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        search_path = path or "/"
        if not self._is_allowed_path(search_path):
            return GlobResult(error=self._path_access_error(search_path), matches=[])
        data = self._run_file_operation(
            {
                "op": "glob",
                "path": search_path,
                "pattern": normalize_glob_pattern(pattern),
                "limits": self._limits_payload(),
            }
        )
        return self._glob_result(search_path, data)

    def _glob_result(
        self,
        search_path: str,
        data: dict[str, object],
    ) -> GlobResult:
        error = data.get("error")
        if error:
            return GlobResult(
                error=f"Error globbing path '{search_path}': {error}",
                matches=[],
            )
        return GlobResult(
            error=bounded_stop_error(
                operation="glob",
                stop_reason=data.get("stop_reason"),
                limits=self.limits,
            ),
            matches=file_infos_from_payload(data.get("matches")),
        )

    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        search_path = path or "/"
        if not self._is_allowed_path(search_path):
            return GlobResult(error=self._path_access_error(search_path), matches=[])
        data = await self._arun_file_operation(
            {
                "op": "glob",
                "path": search_path,
                "pattern": normalize_glob_pattern(pattern),
                "limits": self._limits_payload(),
            }
        )
        return self._glob_result(search_path, data)

    def write(self, file_path: str, content: str) -> WriteResult:
        if not self._is_allowed_path(file_path, writable=True):
            return WriteResult(error=self._path_access_error(file_path, writable=True))
        data = self._run_file_operation(
            {
                "op": "write_check",
                "path": file_path,
                "limits": self._limits_payload(),
            }
        )
        error = data.get("error")
        if error == "file_exists":
            return WriteResult(error=f"Error: File already exists: {file_path!r}")
        if error:
            return WriteResult(error=f"Failed to write file '{file_path}': {error}")
        responses = self.upload_files([(file_path, content.encode("utf-8"))])
        if not responses:
            raise AssertionError("upload_files returned no response")
        response = responses[0]
        if response.error:
            return WriteResult(
                error=f"Failed to write file '{file_path}': {response.error}"
            )
        return WriteResult(path=file_path)

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        if not self._is_allowed_path(file_path, writable=True):
            return WriteResult(error=self._path_access_error(file_path, writable=True))
        data = await self._arun_file_operation(
            {
                "op": "write_check",
                "path": file_path,
                "limits": self._limits_payload(),
            }
        )
        error = data.get("error")
        if error == "file_exists":
            return WriteResult(error=f"Error: File already exists: {file_path!r}")
        if error:
            return WriteResult(error=f"Failed to write file '{file_path}': {error}")
        responses = await self.aupload_files([(file_path, content.encode("utf-8"))])
        if not responses:
            raise AssertionError("upload_files returned no response")
        response = responses[0]
        if response.error:
            return WriteResult(
                error=f"Failed to write file '{file_path}': {response.error}"
            )
        return WriteResult(path=file_path)

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        if not self._is_allowed_path(file_path, writable=True):
            return EditResult(error=self._path_access_error(file_path, writable=True))
        data = self._run_file_operation(
            {
                "op": "edit",
                "path": file_path,
                "old": old_string,
                "new": new_string,
                "replace_all": replace_all,
                "limits": self._limits_payload(),
            }
        )
        error = data.get("error")
        if error:
            return map_edit_error(str(error), file_path, old_string)
        return EditResult(
            path=file_path,
            occurrences=int_value(data.get("count"), 1),
        )

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        if not self._is_allowed_path(file_path, writable=True):
            return EditResult(error=self._path_access_error(file_path, writable=True))
        data = await self._arun_file_operation(
            {
                "op": "edit",
                "path": file_path,
                "old": old_string,
                "new": new_string,
                "replace_all": replace_all,
                "limits": self._limits_payload(),
            }
        )
        error = data.get("error")
        if error:
            return map_edit_error(str(error), file_path, old_string)
        return EditResult(
            path=file_path,
            occurrences=int_value(data.get("count"), 1),
        )

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        for target_path, content in files:
            if not is_absolute_unix_path(target_path):
                responses.append(
                    FileUploadResponse(path=target_path, error="invalid_path")
                )
                continue
            host_path = self._safe_writable_host_path_for_agent_path(target_path)
            if host_path is None:
                responses.append(
                    FileUploadResponse(path=target_path, error="permission_denied")
                )
                continue
            try:
                host_path.parent.mkdir(parents=True, exist_ok=True)
                if host_path.is_dir():
                    responses.append(
                        FileUploadResponse(path=target_path, error="is_directory")
                    )
                    continue
                # O_NOFOLLOW protects the final component from a last-moment
                # symlink swap after the preflight checks above.
                flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                fd = os.open(host_path, flags, 0o666)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(content)
                responses.append(FileUploadResponse(path=target_path, error=None))
            except Exception as error:
                responses.append(
                    FileUploadResponse(
                        path=target_path,
                        error=infer_file_operation_error(str(error)),
                    )
                )
        return responses

    async def aupload_files(
        self,
        files: list[tuple[str, bytes]],
    ) -> list[FileUploadResponse]:
        return await asyncio.to_thread(self.upload_files, files)

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        responses: list[FileDownloadResponse] = []
        for requested_path in paths:
            if not is_absolute_unix_path(requested_path):
                responses.append(
                    FileDownloadResponse(
                        path=requested_path,
                        content=None,
                        error="invalid_path",
                    )
                )
                continue
            unresolved_host_path = self._unresolved_host_path_for_agent_path(
                requested_path
            )
            if unresolved_host_path is None:
                responses.append(
                    FileDownloadResponse(
                        path=requested_path,
                        content=None,
                        error="permission_denied",
                    )
                )
                continue
            if not unresolved_host_path.exists():
                responses.append(
                    FileDownloadResponse(
                        path=requested_path,
                        content=None,
                        error="file_not_found",
                    )
                )
                continue
            host_path = self._safe_existing_host_path_for_agent_path(requested_path)
            if host_path is None:
                responses.append(
                    FileDownloadResponse(
                        path=requested_path,
                        content=None,
                        error="permission_denied",
                    )
                )
                continue
            try:
                if host_path.is_dir():
                    responses.append(
                        FileDownloadResponse(
                            path=requested_path,
                            content=None,
                            error="is_directory",
                        )
                    )
                    continue
                # Match upload hardening: refuse final-component symlinks even
                # if the earlier resolved-path check saw a safe target.
                flags = os.O_RDONLY
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                fd = os.open(host_path, flags)
                with os.fdopen(fd, "rb") as handle:
                    content = handle.read()
                responses.append(
                    FileDownloadResponse(
                        path=requested_path,
                        content=content,
                        error=None,
                    )
                )
            except Exception as error:
                responses.append(
                    FileDownloadResponse(
                        path=requested_path,
                        content=None,
                        error=infer_file_operation_error(str(error)),
                    )
                )
        return responses

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return await asyncio.to_thread(self.download_files, paths)
