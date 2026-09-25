"""Docker-backed sandbox implementation for agent-visible filesystem tools."""

# Design notes for maintainers:
#
# This Docker backend intentionally implements DeepAgents' SandboxBackendProtocol
# directly. The file operations below were derived from BaseSandbox's
# container-side Python/shell approach and then made into this backend's own
# contract: agent/container path mapping, readable/writable bounds, shared
# filesystem resource budgets, and newline-tolerant edits.
#
# The important split is: Docker runtime owns container lifecycle and Docker CLI
# primitives; this backend owns the agent-visible filesystem behavior inside
# that container. Do not route `ls`, `read`, `grep`, `glob`, `write`, `edit`,
# or their async counterparts through BaseSandbox unless you are also willing
# to give up those local contracts.
#
# Maintenance risk: this file now carries a forked application-level copy of the
# BaseSandbox file-operation idea, not a transparent upstream implementation.
# When upgrading deepagents, compare their protocol result shapes and sandbox
# transport assumptions, but keep our promises tested here: bounded traversal,
# container paths mapped back to agent paths, explicit writable roots, and
# newline-tolerant edits.

import asyncio
import base64
import json
import os
import shlex
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path

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

from sec_review_agents.filesystem import docker_runtime
from sec_review_agents.filesystem.command_output import text_output, truncate_output
from sec_review_agents.filesystem.docker_runtime import (
    DockerContainerResource,
    combine_command_output,
)
from sec_review_agents.filesystem.limits import (
    FilesystemLimits,
    bounded_filesystem_error,
    default_filesystem_limits,
    effective_grep_max_matches,
)
from sec_review_agents.filesystem.result_parsing import (
    file_infos_from_payload,
    grep_matches_from_payload,
    infer_file_operation_error,
    int_value,
    map_edit_error,
)
from sec_review_agents.filesystem.sandbox_file_ops import (
    EDIT_INLINE_MAX_BYTES,
    file_operation_script,
)
from sec_review_agents.filesystem.unix_paths import (
    is_absolute_unix_path,
    normalize_glob_pattern,
    normalize_unix_path,
    unix_path_has_prefix,
)
from sec_review_agents.utils.env import env_value, parse_bool_env, parse_int_env


@dataclass(frozen=True)
class DockerRoute:
    """Map an agent-visible path prefix to a Docker container path prefix."""

    container_path: str
    agent_path: str
    writable: bool


def _is_root_docker_user(user: str | None) -> bool:
    if user is None:
        return True
    normalized = user.strip()
    return normalized in {"", "0", "0:0", "root", "root:root"}


class DockerSandboxBackend(SandboxBackendProtocol):
    def __init__(
        self,
        *,
        container: DockerContainerResource,
        routes: list[DockerRoute],
        limits: FilesystemLimits | None = None,
    ) -> None:
        self.container = container
        self.container_name = container.container_name
        self.shell = container.shell
        self.user = container.user
        self.ownership_uid = os.getuid() if hasattr(os, "getuid") else None
        self.ownership_gid = os.getgid() if hasattr(os, "getgid") else None
        self.normalize_writable_mount_ownership = parse_bool_env(
            env_value("AGENT_DOCKER_NORMALIZE_WRITABLE_MOUNT_OWNERSHIP"),
            True,
        )
        self.command_timeout_ms = container.timeout_ms
        self.max_output_bytes = (
            parse_int_env(
                env_value("AGENT_DOCKER_MAX_OUTPUT_BYTES"),
                1024 * 1024,
            )
            or 1024 * 1024
        )
        self.mounts = container.mounts
        self.working_directory = container.working_directory
        self.environment = container.environment
        self.limits = limits or default_filesystem_limits()
        self.routes = routes
        self.readable_prefixes = tuple(
            sorted(
                {normalize_unix_path(binding.container_path) for binding in self.routes}
            )
        )
        self.writable_prefixes = tuple(
            sorted(
                {
                    normalize_unix_path(binding.container_path)
                    for binding in self.routes
                    if binding.writable
                }
            )
        )
        self.edit_temp_root = (
            self.writable_prefixes[0] if self.writable_prefixes else None
        )

    def _should_normalize_ownership(self) -> bool:
        """Return whether writable mount ownership should be normalized on close."""
        # Ownership normalization is a host-cleanup convenience, not an access
        # control mechanism. It is safe under the default root container user
        # because root can keep reading/writing files after they are chowned back
        # to the host uid/gid. If a caller runs the sandbox as another non-root
        # uid, chowning writable mounts to the host user can make later agent
        # operations fail with EACCES, so require an explicit matching uid/gid in
        # that configuration.
        docker_user_matches_host = (
            self.user == f"{self.ownership_uid}:{self.ownership_gid}"
        )
        return (
            self.normalize_writable_mount_ownership
            and self.ownership_uid is not None
            and self.ownership_gid is not None
            and any(mount.writable for mount in self.mounts)
            and (_is_root_docker_user(self.user) or docker_user_matches_host)
        )

    def _normalize_mount_ownership(self) -> None:
        if not self._should_normalize_ownership():
            return

        writable_mount_paths = [
            normalize_unix_path(mount.container_path)
            for mount in self.mounts
            if mount.writable and is_absolute_unix_path(mount.container_path)
        ]
        if not writable_mount_paths:
            return

        quoted_paths = " ".join(shlex.quote(path) for path in writable_mount_paths)
        command = f"chown -R {self.ownership_uid}:{self.ownership_gid} {quoted_paths} 2>/dev/null || true"
        docker_runtime.exec_shell(
            container_name=self.container_name,
            shell=self.shell,
            command=command,
            timeout_ms=self.command_timeout_ms,
            expect_success=False,
        )

    def finalize(self) -> None:
        """Normalize writable mounts once before the container is stopped.

        Mount ownership is a host-side cleanup concern. Running a recursive
        ``chown`` after every file operation makes each read or edit scan the
        whole workspace and can stall an agent on larger repositories.
        ``managed_backend`` calls this method at the end of the backend
        lifetime, so normal tool operations never pay that cost.
        """
        self._normalize_mount_ownership()

    @property
    def id(self) -> str:
        return self.container_name

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        self.container.ensure_started()

        effective_timeout_ms = (
            (timeout * 1000) if timeout is not None else self.command_timeout_ms
        )
        try:
            result = docker_runtime.exec_shell(
                container_name=self.container_name,
                shell=self.shell,
                command=command,
                timeout_ms=effective_timeout_ms,
                expect_success=False,
                working_directory=self.working_directory,
                environment=self.environment,
            )
        except subprocess.TimeoutExpired as error:
            timeout_desc = (
                f"{effective_timeout_ms / 1000:g} seconds"
                if effective_timeout_ms is not None
                else "the configured timeout"
            )
            return self._timeout_response(error, timeout_desc)
        output, truncated = truncate_output(
            combine_command_output(result.stdout, result.stderr),
            self.max_output_bytes,
        )
        return ExecuteResponse(
            output=output,
            exit_code=result.returncode,
            truncated=truncated,
        )

    async def aexecute(
        self,
        command: str,
        *,
        timeout: int | None = None,
    ) -> ExecuteResponse:
        await asyncio.to_thread(self.container.ensure_started)

        effective_timeout_ms = (
            (timeout * 1000) if timeout is not None else self.command_timeout_ms
        )
        try:
            result = await docker_runtime.aexec_shell(
                container_name=self.container_name,
                shell=self.shell,
                command=command,
                timeout_ms=effective_timeout_ms,
                expect_success=False,
                working_directory=self.working_directory,
                environment=self.environment,
            )
        except subprocess.TimeoutExpired as error:
            timeout_desc = (
                f"{effective_timeout_ms / 1000:g} seconds"
                if effective_timeout_ms is not None
                else "the configured timeout"
            )
            return self._timeout_response(error, timeout_desc)
        output, truncated = truncate_output(
            combine_command_output(result.stdout, result.stderr),
            self.max_output_bytes,
        )
        return ExecuteResponse(
            output=output,
            exit_code=result.returncode,
            truncated=truncated,
        )

    def _timeout_response(
        self,
        error: subprocess.TimeoutExpired,
        timeout_desc: str,
    ) -> ExecuteResponse:
        output = combine_command_output(
            text_output(error.stdout),
            text_output(error.stderr),
        )
        if output:
            output += "\n"
        output += f"Command timed out after {timeout_desc}."
        truncated_output, truncated = truncate_output(output, self.max_output_bytes)
        return ExecuteResponse(
            output=truncated_output,
            exit_code=124,
            truncated=truncated,
        )

    def _is_allowed_path(self, path: str, *, writable: bool = False) -> bool:
        if not is_absolute_unix_path(path):
            return False

        normalized = self._to_container_path(path)

        prefixes = self.writable_prefixes if writable else self.readable_prefixes
        return any(unix_path_has_prefix(normalized, prefix) for prefix in prefixes)

    def sandbox_path_for_agent_path(
        self,
        path: str,
        *,
        require_writable: bool = False,
    ) -> str | None:
        if not self._is_allowed_path(path, writable=require_writable):
            return None
        return self._to_container_path(path)

    def _to_container_path(self, path: str) -> str:
        normalized = normalize_unix_path(path)
        matching_bindings = sorted(
            self.routes,
            key=lambda binding: len(normalize_unix_path(binding.agent_path)),
            reverse=True,
        )
        for binding in matching_bindings:
            agent_prefix = normalize_unix_path(binding.agent_path)
            if not unix_path_has_prefix(normalized, agent_prefix):
                continue
            container_prefix = normalize_unix_path(binding.container_path)
            suffix = normalized[len(agent_prefix) :].lstrip("/")
            return (
                container_prefix
                if not suffix
                else normalize_unix_path(f"{container_prefix}/{suffix}")
            )
        return normalized

    def _to_agent_path(self, path: str) -> str:
        normalized = normalize_unix_path(path)
        matching_bindings = sorted(
            self.routes,
            key=lambda binding: len(normalize_unix_path(binding.container_path)),
            reverse=True,
        )
        for binding in matching_bindings:
            container_prefix = normalize_unix_path(binding.container_path)
            if not unix_path_has_prefix(normalized, container_prefix):
                continue
            agent_prefix = normalize_unix_path(binding.agent_path)
            suffix = normalized[len(container_prefix) :].lstrip("/")
            return (
                agent_prefix
                if not suffix
                else normalize_unix_path(f"{agent_prefix}/{suffix}")
            )
        return normalized

    def _limits_payload(
        self, *, grep_max_count: int | None = None
    ) -> dict[str, object]:
        return {
            "glob_max_results": self.limits.glob_max_results,
            "glob_max_seconds": self.limits.glob_max_seconds,
            "glob_max_visited": self.limits.glob_max_visited,
            "grep_max_matches": effective_grep_max_matches(
                self.limits,
                grep_max_count,
            ),
            "grep_max_seconds": self.limits.grep_max_seconds,
            "grep_max_files": self.limits.grep_max_files,
            "ls_max_entries": self.limits.ls_max_entries,
            "read_max_bytes": self.limits.read_max_bytes,
            "read_max_scan_bytes": self.limits.read_max_scan_bytes,
            "ignored_dirs": sorted(self.limits.ignored_dirs),
        }

    def _run_file_operation(self, payload: dict[str, object]) -> dict[str, object]:
        script = file_operation_script(payload)
        result = self.execute(f"python3 -c {shlex.quote(script)}")
        return self._parse_file_operation_output(result.output)

    async def _arun_file_operation(
        self,
        payload: dict[str, object],
    ) -> dict[str, object]:
        script = file_operation_script(payload)
        result = await self.aexecute(f"python3 -c {shlex.quote(script)}")
        return self._parse_file_operation_output(result.output)

    def _parse_file_operation_output(self, output: str) -> dict[str, object]:
        output = output.rstrip()
        try:
            data = json.loads(output)
        except json.JSONDecodeError, ValueError:
            detail = output[:200] if output else "(empty)"
            return {"error": f"unexpected server response: {detail}"}
        if not isinstance(data, dict):
            detail = output[:200] if output else "(empty)"
            return {"error": f"unexpected server response: {detail}"}
        return data

    def _bounded_stop_error(
        self,
        operation: str,
        stop_reason: object,
        *,
        grep_max_count: int | None = None,
    ) -> str | None:
        if stop_reason is None:
            return None
        effective_grep_limit = effective_grep_max_matches(
            self.limits,
            grep_max_count,
        )
        reasons = {
            "entry_limit": f"entry limit {self.limits.ls_max_entries} reached",
            "result_limit": f"result limit {self.limits.glob_max_results} reached",
            "visited_limit": f"visited file limit {self.limits.glob_max_visited} reached",
            "time_limit": (
                f"time limit {self.limits.glob_max_seconds:g}s reached"
                if operation == "glob"
                else f"time limit {self.limits.grep_max_seconds:g}s reached"
            ),
            "file_limit": f"file limit {self.limits.grep_max_files} reached",
            "match_limit": f"match limit {effective_grep_limit} reached",
        }
        return bounded_filesystem_error(
            operation,
            reasons.get(str(stop_reason), str(stop_reason)),
        )

    def _path_access_error(self, path: str, *, writable: bool = False) -> str:
        normalized = (
            self._to_container_path(path) if is_absolute_unix_path(path) else str(path)
        )
        action = "write" if writable else "access"
        return f"Path '{normalized}' is outside the sandbox file roots available for {action}"

    def ls(self, path: str) -> LsResult:
        if not self._is_allowed_path(path):
            return LsResult(error=self._path_access_error(path))
        data = self._run_file_operation(
            {
                "op": "ls",
                "path": self._to_container_path(path),
                "limits": self._limits_payload(),
            }
        )
        entries = file_infos_from_payload(data.get("entries"))
        for entry in entries:
            entry["path"] = self._to_agent_path(entry["path"])
        error = data.get("error")
        return LsResult(
            error=(
                self._bounded_stop_error("ls", error)
                if error == "entry_limit"
                else str(error) if error else None
            ),
            entries=entries,
        )

    async def als(self, path: str) -> LsResult:
        if not self._is_allowed_path(path):
            return LsResult(error=self._path_access_error(path))
        data = await self._arun_file_operation(
            {
                "op": "ls",
                "path": self._to_container_path(path),
                "limits": self._limits_payload(),
            }
        )
        entries = file_infos_from_payload(data.get("entries"))
        for entry in entries:
            entry["path"] = self._to_agent_path(entry["path"])
        error = data.get("error")
        return LsResult(
            error=(
                self._bounded_stop_error("ls", error)
                if error == "entry_limit"
                else str(error) if error else None
            ),
            entries=entries,
        )

    def read(
        self,
        file_path: str,
        offset: int = 0,
        limit: int = 2000,
    ) -> ReadResult:
        if not self._is_allowed_path(file_path):
            return ReadResult(error=self._path_access_error(file_path))
        container_path = self._to_container_path(file_path)
        data = self._run_file_operation(
            {
                "op": "read",
                "path": container_path,
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
        if error == "file_not_found":
            return ReadResult(error=f"File '{file_path}' not found")
        if error == "offset_exceeds_length":
            return ReadResult(
                error=(
                    f"Line offset {offset} exceeds file length "
                    f"({data.get('line_count', 0)} lines)"
                )
            )
        if error == "read_max_bytes":
            return ReadResult(
                error=bounded_filesystem_error(
                    "read_file",
                    (
                        f"file size {data.get('size')} bytes exceeds limit "
                        f"{self.limits.read_max_bytes} bytes"
                    ),
                )
            )
        if error == "read_max_scan_bytes":
            return ReadResult(
                error=bounded_filesystem_error(
                    "read_file",
                    (
                        f"scan limit {self.limits.read_max_scan_bytes} bytes "
                        "reached before requested window"
                    ),
                )
            )
        if error:
            return ReadResult(error=f"Error reading file '{file_path}': {error}")
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
        container_path = self._to_container_path(file_path)
        data = await self._arun_file_operation(
            {
                "op": "read",
                "path": container_path,
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
        search_path = path or self.working_directory
        if not self._is_allowed_path(search_path):
            return GrepResult(error=self._path_access_error(search_path))
        data = self._run_file_operation(
            {
                "op": "grep",
                "path": self._to_container_path(search_path),
                "pattern": pattern,
                "glob": normalize_glob_pattern(glob or "**/*"),
                "limits": self._limits_payload(grep_max_count=max_count),
            }
        )
        return self._grep_result(pattern_path=path, data=data, max_count=max_count)

    def _grep_result(
        self,
        *,
        pattern_path: str | None,
        data: dict[str, object],
        max_count: int | None = None,
    ) -> GrepResult:
        error = data.get("error")
        if error:
            return GrepResult(
                error=f"Error grepping path '{pattern_path}': {error}", matches=[]
            )
        return GrepResult(
            error=self._bounded_stop_error(
                "grep",
                data.get("stop_reason"),
                grep_max_count=max_count,
            ),
            matches=[
                {
                    **match,
                    "path": self._to_agent_path(match["path"]),
                }
                for match in grep_matches_from_payload(data.get("matches"))
            ],
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
        search_path = path or self.working_directory
        if not self._is_allowed_path(search_path):
            return GrepResult(error=self._path_access_error(search_path))
        data = await self._arun_file_operation(
            {
                "op": "grep",
                "path": self._to_container_path(search_path),
                "pattern": pattern,
                "glob": normalize_glob_pattern(glob or "**/*"),
                "limits": self._limits_payload(grep_max_count=max_count),
            }
        )
        return self._grep_result(pattern_path=path, data=data, max_count=max_count)

    def glob(self, pattern: str, path: str | None = "/") -> GlobResult:
        search_path = path or "/"
        if not self._is_allowed_path(search_path):
            return GlobResult(error=self._path_access_error(search_path))
        data = self._run_file_operation(
            {
                "op": "glob",
                "path": self._to_container_path(search_path),
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
                error=f"Error globbing path '{search_path}': {error}", matches=[]
            )
        return GlobResult(
            error=self._bounded_stop_error("glob", data.get("stop_reason")),
            matches=[
                {
                    **match,
                    "path": self._to_agent_path(match["path"]),
                }
                for match in file_infos_from_payload(data.get("matches"))
            ],
        )

    async def aglob(self, pattern: str, path: str | None = "/") -> GlobResult:
        search_path = path or "/"
        if not self._is_allowed_path(search_path):
            return GlobResult(error=self._path_access_error(search_path))
        data = await self._arun_file_operation(
            {
                "op": "glob",
                "path": self._to_container_path(search_path),
                "pattern": normalize_glob_pattern(pattern),
                "limits": self._limits_payload(),
            }
        )
        return self._glob_result(search_path, data)

    def write(
        self,
        file_path: str,
        content: str,
    ) -> WriteResult:
        if not self._is_allowed_path(file_path, writable=True):
            return WriteResult(error=self._path_access_error(file_path, writable=True))
        container_path = self._to_container_path(file_path)
        data = self._run_file_operation(
            {
                "op": "write_check",
                "path": container_path,
                "limits": self._limits_payload(),
            }
        )
        error = data.get("error")
        if error == "file_exists":
            return WriteResult(error=f"Error: File already exists: {container_path!r}")
        if error:
            return WriteResult(
                error=f"Failed to write file '{container_path}': {error}"
            )

        responses = self.upload_files([(file_path, content.encode("utf-8"))])
        if not responses:
            raise AssertionError(
                f"Responses was expected to return 1 result, but it returned {len(responses)}"
            )
        response = responses[0]
        result = (
            WriteResult(
                error=f"Failed to write file '{container_path}': {response.error}"
            )
            if response.error
            else WriteResult(path=file_path)
        )
        return result

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        if not self._is_allowed_path(file_path, writable=True):
            return WriteResult(error=self._path_access_error(file_path, writable=True))
        container_path = self._to_container_path(file_path)
        data = await self._arun_file_operation(
            {
                "op": "write_check",
                "path": container_path,
                "limits": self._limits_payload(),
            }
        )
        error = data.get("error")
        if error == "file_exists":
            return WriteResult(error=f"Error: File already exists: {container_path!r}")
        if error:
            return WriteResult(
                error=f"Failed to write file '{container_path}': {error}"
            )

        responses = await self.aupload_files([(file_path, content.encode("utf-8"))])
        if not responses:
            raise AssertionError(
                f"Responses was expected to return 1 result, but it returned {len(responses)}"
            )
        response = responses[0]
        result = (
            WriteResult(
                error=f"Failed to write file '{container_path}': {response.error}"
            )
            if response.error
            else WriteResult(path=file_path)
        )
        return result

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        if not self._is_allowed_path(file_path, writable=True):
            return EditResult(error=self._path_access_error(file_path, writable=True))
        normalized_path = self._to_container_path(file_path)
        payload_size = len(old_string.encode("utf-8")) + len(new_string.encode("utf-8"))

        if payload_size <= EDIT_INLINE_MAX_BYTES:
            result = self._edit_inline_newline_tolerant(
                normalized_path,
                old_string,
                new_string,
                replace_all,
                result_path=file_path,
            )
            return result

        if self.edit_temp_root is None:
            return EditResult(
                error=f"Error editing file '{normalized_path}': no writable mount available for temp files"
            )

        result = self._edit_via_allowed_upload(
            normalized_path,
            old_string,
            new_string,
            replace_all,
            result_path=file_path,
        )
        return result

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        if not self._is_allowed_path(file_path, writable=True):
            return EditResult(error=self._path_access_error(file_path, writable=True))
        normalized_path = self._to_container_path(file_path)
        payload_size = len(old_string.encode("utf-8")) + len(new_string.encode("utf-8"))

        if payload_size <= EDIT_INLINE_MAX_BYTES:
            result = await self._aedit_inline_newline_tolerant(
                normalized_path,
                old_string,
                new_string,
                replace_all,
                result_path=file_path,
            )
            return result

        if self.edit_temp_root is None:
            return EditResult(
                error=f"Error editing file '{normalized_path}': no writable mount available for temp files"
            )

        result = await self._aedit_via_allowed_upload(
            normalized_path,
            old_string,
            new_string,
            replace_all,
            result_path=file_path,
        )
        return result

    def _edit_inline_newline_tolerant(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool,
        *,
        result_path: str,
    ) -> EditResult:
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
        if "error" in data:
            return map_edit_error(str(data["error"]), result_path, old_string)
        return EditResult(
            path=result_path,
            occurrences=int_value(data.get("count"), 1),
        )

    async def _aedit_inline_newline_tolerant(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool,
        *,
        result_path: str,
    ) -> EditResult:
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
        if "error" in data:
            return map_edit_error(str(data["error"]), result_path, old_string)
        return EditResult(
            path=result_path,
            occurrences=int_value(data.get("count"), 1),
        )

    def _edit_via_allowed_upload(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool,
        *,
        result_path: str | None = None,
    ) -> EditResult:
        uid = base64.b32encode(uuid.uuid4().bytes).decode("ascii").lower().rstrip("=")
        old_tmp = f"{self.edit_temp_root}/.deepagents_edit_{uid}_old"
        new_tmp = f"{self.edit_temp_root}/.deepagents_edit_{uid}_new"

        responses = self.upload_files(
            [
                (old_tmp, old_string.encode("utf-8")),
                (new_tmp, new_string.encode("utf-8")),
            ]
        )
        if len(responses) < 2:
            self._cleanup_edit_temp_files(old_tmp, new_tmp)
            return EditResult(
                error=f"Error editing file '{file_path}': upload returned no response"
            )
        for response in responses:
            if response.error:
                self._cleanup_edit_temp_files(old_tmp, new_tmp)
                return EditResult(
                    error=f"Error editing file '{file_path}': {response.error}"
                )

        data = self._run_file_operation(
            {
                "op": "edit",
                "path": file_path,
                "old_path": old_tmp,
                "new_path": new_tmp,
                "replace_all": replace_all,
                "limits": self._limits_payload(),
            }
        )
        try:
            if "error" in data:
                return map_edit_error(
                    str(data["error"]),
                    result_path or file_path,
                    old_string,
                )
            return EditResult(
                path=result_path or file_path,
                occurrences=int_value(data.get("count"), 1),
            )
        finally:
            self._cleanup_edit_temp_files(old_tmp, new_tmp)

    async def _aedit_via_allowed_upload(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool,
        *,
        result_path: str | None = None,
    ) -> EditResult:
        uid = base64.b32encode(uuid.uuid4().bytes).decode("ascii").lower().rstrip("=")
        old_tmp = f"{self.edit_temp_root}/.deepagents_edit_{uid}_old"
        new_tmp = f"{self.edit_temp_root}/.deepagents_edit_{uid}_new"

        responses = await self.aupload_files(
            [
                (old_tmp, old_string.encode("utf-8")),
                (new_tmp, new_string.encode("utf-8")),
            ]
        )
        if len(responses) < 2:
            await self._acleanup_edit_temp_files(old_tmp, new_tmp)
            return EditResult(
                error=f"Error editing file '{file_path}': upload returned no response"
            )
        for response in responses:
            if response.error:
                await self._acleanup_edit_temp_files(old_tmp, new_tmp)
                return EditResult(
                    error=f"Error editing file '{file_path}': {response.error}"
                )

        data = await self._arun_file_operation(
            {
                "op": "edit",
                "path": file_path,
                "old_path": old_tmp,
                "new_path": new_tmp,
                "replace_all": replace_all,
                "limits": self._limits_payload(),
            }
        )
        try:
            if "error" in data:
                return map_edit_error(
                    str(data["error"]),
                    result_path or file_path,
                    old_string,
                )
            return EditResult(
                path=result_path or file_path,
                occurrences=int_value(data.get("count"), 1),
            )
        finally:
            await self._acleanup_edit_temp_files(old_tmp, new_tmp)

    def _cleanup_edit_temp_files(self, *paths: str) -> None:
        """Remove staged large-edit payloads from the container best-effort."""
        quoted_paths = " ".join(shlex.quote(path) for path in paths)
        if not quoted_paths:
            return
        try:
            self.execute(f"rm -f {quoted_paths}")
        except Exception:
            pass

    async def _acleanup_edit_temp_files(self, *paths: str) -> None:
        """Remove staged large-edit payloads from the container best-effort."""
        quoted_paths = " ".join(shlex.quote(path) for path in paths)
        if not quoted_paths:
            return
        try:
            await self.aexecute(f"rm -f {quoted_paths}")
        except Exception:
            pass

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        # Defer container startup until a path passes local validation; invalid
        # tool calls should return cheap errors without paying Docker startup cost.
        initialized = False

        with tempfile.TemporaryDirectory(prefix="docker-sandbox-upload-") as temp_dir:
            for target_path, content in files:
                if not is_absolute_unix_path(target_path):
                    responses.append(
                        FileUploadResponse(path=target_path, error="invalid_path")
                    )
                    continue
                if not self._is_allowed_path(target_path, writable=True):
                    responses.append(
                        FileUploadResponse(path=target_path, error="permission_denied")
                    )
                    continue

                normalized_target_path = self._to_container_path(target_path)
                temp_file_path = Path(temp_dir) / uuid.uuid4().hex
                temp_file_path.write_bytes(content)

                try:
                    if not initialized:
                        self.container.ensure_started()
                        initialized = True
                    parent_dir = str(Path(normalized_target_path).parent).replace(
                        "\\", "/"
                    )
                    docker_runtime.exec_shell(
                        container_name=self.container_name,
                        shell=self.shell,
                        command=f"mkdir -p {shlex.quote(parent_dir)}",
                        timeout_ms=self.command_timeout_ms,
                    )
                    docker_runtime.copy_to_container(
                        container_name=self.container_name,
                        source=temp_file_path,
                        target_path=normalized_target_path,
                        timeout_ms=self.command_timeout_ms,
                    )
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

    def _probe_path_kind(self, target_path: str) -> str:
        probe = (
            f"if [ -d {shlex.quote(target_path)} ]; then printf directory; "
            f"elif [ -f {shlex.quote(target_path)} ]; then printf file; "
            "else printf missing; fi"
        )
        result = docker_runtime.exec_shell(
            container_name=self.container_name,
            shell=self.shell,
            command=probe,
            timeout_ms=self.command_timeout_ms,
            expect_success=False,
        )
        return (
            combine_command_output(result.stdout, result.stderr)
            .replace("[stderr] ", "")
            .strip()
        )

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        responses: list[FileDownloadResponse] = []
        # Defer container startup until a path passes local validation; invalid
        # tool calls should return cheap errors without paying Docker startup cost.
        initialized = False

        with tempfile.TemporaryDirectory(prefix="docker-sandbox-download-") as temp_dir:
            for requested_path in paths:
                if not is_absolute_unix_path(requested_path):
                    responses.append(
                        FileDownloadResponse(
                            path=requested_path, content=None, error="invalid_path"
                        )
                    )
                    continue
                if not self._is_allowed_path(requested_path):
                    responses.append(
                        FileDownloadResponse(
                            path=requested_path, content=None, error="permission_denied"
                        )
                    )
                    continue

                normalized_requested_path = self._to_container_path(requested_path)
                if not initialized:
                    self.container.ensure_started()
                    initialized = True
                path_kind = self._probe_path_kind(normalized_requested_path)
                if path_kind == "missing":
                    responses.append(
                        FileDownloadResponse(
                            path=requested_path,
                            content=None,
                            error="file_not_found",
                        )
                    )
                    continue
                if path_kind == "directory":
                    responses.append(
                        FileDownloadResponse(
                            path=requested_path,
                            content=None,
                            error="is_directory",
                        )
                    )
                    continue

                temp_file_path = Path(temp_dir) / uuid.uuid4().hex
                try:
                    docker_runtime.copy_from_container(
                        container_name=self.container_name,
                        source_path=normalized_requested_path,
                        target=temp_file_path,
                        timeout_ms=self.command_timeout_ms,
                    )
                    responses.append(
                        FileDownloadResponse(
                            path=requested_path,
                            content=temp_file_path.read_bytes(),
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
