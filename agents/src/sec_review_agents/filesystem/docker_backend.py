"""Docker lifecycle and path policy around upstream file operations."""

import asyncio
import logging
import os
import shlex
import subprocess
from dataclasses import dataclass
from types import TracebackType
from typing import Self

from deepagents.backends.protocol import (
    DeleteResult,
    EditResult,
    ExecuteResponse,
    FileDownloadResponse,
    FileUploadResponse,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)
from deepagents.backends.sandbox import BaseSandbox

from sec_review_agents.filesystem import docker_runtime
from sec_review_agents.filesystem.command_output import text_output, truncate_output
from sec_review_agents.filesystem.docker_runtime import (
    DockerContainerResource,
    combine_command_output,
)
from sec_review_agents.filesystem.docker_transfer_ops import (
    docker_transfer_error,
    docker_transfer_script,
)
from sec_review_agents.filesystem.result_parsing import infer_file_operation_error
from sec_review_agents.filesystem.unix_paths import (
    is_absolute_unix_path,
    normalize_unix_path,
    unix_path_has_prefix,
)
from sec_review_agents.utils.env import bool_env, int_env

# Standard-library logging, not the project's structlog wrapper: `filesystem` is a foundational
# package and may not import `observability`. A cleanup failure during an exceptional exit has
# no other channel, and silence is what makes a stranded container invisible.
_logger = logging.getLogger(__name__)


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


class DockerSandboxBackend(BaseSandbox):
    def __init__(
        self,
        *,
        container: DockerContainerResource,
        routes: list[DockerRoute],
    ) -> None:
        self.container = container
        self._closed = False
        self.container_name = container.container_name
        self.shell = container.shell
        self.user = container.user
        self.ownership_uid = os.getuid() if hasattr(os, "getuid") else None
        self.ownership_gid = os.getgid() if hasattr(os, "getgid") else None
        self.normalize_writable_mount_ownership = bool_env(
            "AGENT_DOCKER_NORMALIZE_WRITABLE_MOUNT_OWNERSHIP", True
        )
        self.command_timeout_ms = container.timeout_ms
        self.max_output_bytes = int_env(
            "AGENT_DOCKER_MAX_OUTPUT_BYTES", 1024 * 1024, minimum=1
        )
        self.mounts = container.mounts
        self.working_directory = container.working_directory
        self.environment = container.environment
        # /tmp belongs to the container, not to repository material mounts.
        # Upstream large edits upload temporary payloads here.
        tmp_routes = [
            route for route in routes if normalize_unix_path(route.agent_path) == "/tmp"
        ]
        if any(
            normalize_unix_path(route.container_path) != "/tmp" or not route.writable
            for route in tmp_routes
        ):
            raise ValueError("Docker /tmp must be a writable container-native path")
        self.routes = list(routes)
        if not tmp_routes:
            self.routes.append(
                DockerRoute(container_path="/tmp", agent_path="/tmp", writable=True)
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
        ``amanaged_backend`` calls this method at the end of the backend
        lifetime, so normal tool operations never pay that cost.
        """
        self._normalize_mount_ownership()

    async def afinalize(self) -> None:
        """Normalize writable mounts without blocking an async caller."""
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
        await docker_runtime.aexec_shell(
            container_name=self.container_name,
            shell=self.shell,
            command=command,
            timeout_ms=self.command_timeout_ms,
            expect_success=False,
        )

    def close(self) -> None:
        """Finish backend cleanup and stop the owned Docker container."""
        if self._closed:
            return
        # The two failures mean different things, so the flags are decided separately:
        #
        # - removing the container failed: nothing was torn down and the caller can retry, so
        #   this backend stays open;
        # - removing the container succeeded but `finalize` raised: the container is gone and
        #   saying otherwise would have the caller believe it is still running.
        try:
            self.finalize()
        finally:
            self.container.close()
            if self.container.closed:
                self._closed = True

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        # A container outlives the interpreter that started it, so a missed cleanup strands it
        # rather than failing loudly. The two exit paths disagree about what a cleanup failure
        # means, so they are handled separately:
        #
        # - normal exit: nothing else is reporting a problem, so a cleanup failure is the only
        #   signal the caller has that the sandbox may still be running. It must propagate.
        # - exceptional exit: the block's exception is what the caller needs to see. A cleanup
        #   failure is logged instead of replacing it, and the original exception propagates
        #   with its type unchanged.
        del exc_type, traceback
        if exc_value is None:
            self.close()
            return

        try:
            self.close()
        except Exception:
            _logger.warning(
                "Docker sandbox cleanup failed for %s while another exception was propagating",
                self.container_name,
                exc_info=True,
            )

    async def aclose(self) -> None:
        """Finish backend cleanup without blocking the async caller."""
        if self._closed:
            return
        # Same split as `close`: a failed removal stays retryable, a completed removal is
        # recorded even when `afinalize` raised.
        try:
            await self.afinalize()
        finally:
            await asyncio.to_thread(self.container.close)
            if self.container.closed:
                self._closed = True

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
            combine_command_output(result.stdout, result.stderr) or "<no output>",
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
            combine_command_output(result.stdout, result.stderr) or "<no output>",
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

        # Authorize the most specific agent route before mapping it. A writable
        # container parent (such as /tmp) must not override a read-only route.
        return self._transfer_route(path, require_writable=writable) is not None

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

    def _transfer_route(
        self,
        path: str,
        *,
        require_writable: bool = False,
    ) -> tuple[str, tuple[str, ...]] | None:
        normalized = normalize_unix_path(path)
        for binding in sorted(
            self.routes,
            key=lambda item: len(normalize_unix_path(item.agent_path)),
            reverse=True,
        ):
            agent_root = normalize_unix_path(binding.agent_path)
            if not unix_path_has_prefix(normalized, agent_root):
                continue
            if require_writable and not binding.writable:
                return None
            suffix = normalized[len(agent_root) :].lstrip("/")
            return (
                normalize_unix_path(binding.container_path),
                tuple(part for part in suffix.split("/") if part),
            )
        return None

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

    def _path_access_error(self, path: str, *, writable: bool = False) -> str:
        normalized = (
            self._to_container_path(path) if is_absolute_unix_path(path) else str(path)
        )
        action = "write" if writable else "access"
        return f"Path '{normalized}' is outside the sandbox file roots available for {action}"

    def ls(self, path: str) -> LsResult:
        if not self._is_allowed_path(path):
            return LsResult(error=self._path_access_error(path))
        result = super().ls(self._to_container_path(path))
        for item in result.entries or []:
            item["path"] = self._to_agent_path(item["path"])
        return result

    async def als(self, path: str) -> LsResult:
        if not self._is_allowed_path(path):
            return LsResult(error=self._path_access_error(path))
        result = await super().als(self._to_container_path(path))
        for item in result.entries or []:
            item["path"] = self._to_agent_path(item["path"])
        return result

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        if not self._is_allowed_path(file_path):
            return ReadResult(error=self._path_access_error(file_path))
        result = super().read(self._to_container_path(file_path), offset, limit)
        return result

    async def aread(
        self, file_path: str, offset: int = 0, limit: int = 2000
    ) -> ReadResult:
        if not self._is_allowed_path(file_path):
            return ReadResult(error=self._path_access_error(file_path))
        result = await super().aread(self._to_container_path(file_path), offset, limit)
        return result

    def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        path = path or self.working_directory
        if not self._is_allowed_path(path):
            return GlobResult(error=self._path_access_error(path))
        result = super().glob(pattern, self._to_container_path(path))
        for item in result.matches or []:
            item["path"] = self._to_agent_path(item["path"])
        return result

    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        path = path or self.working_directory
        if not self._is_allowed_path(path):
            return GlobResult(error=self._path_access_error(path))
        result = await super().aglob(pattern, self._to_container_path(path))
        for item in result.matches or []:
            item["path"] = self._to_agent_path(item["path"])
        return result

    def grep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        path = path or self.working_directory
        if not self._is_allowed_path(path):
            return GrepResult(error=self._path_access_error(path))
        result = super().grep(
            pattern, self._to_container_path(path), glob, max_count=max_count
        )
        for item in result.matches or []:
            item["path"] = self._to_agent_path(item["path"])
        return result

    async def agrep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        path = path or self.working_directory
        if not self._is_allowed_path(path):
            return GrepResult(error=self._path_access_error(path))
        result = await super().agrep(
            pattern, self._to_container_path(path), glob, max_count=max_count
        )
        for item in result.matches or []:
            item["path"] = self._to_agent_path(item["path"])
        return result

    def write(self, file_path: str, content: str) -> WriteResult:
        if not self._is_allowed_path(file_path, writable=True):
            return WriteResult(error=self._path_access_error(file_path, writable=True))
        return super().write(file_path, content)

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        return await asyncio.to_thread(self.write, file_path, content)

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        if not self._is_allowed_path(file_path, writable=True):
            return EditResult(error=self._path_access_error(file_path, writable=True))
        return super().edit(file_path, old_string, new_string, replace_all)

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        return await asyncio.to_thread(
            self.edit, file_path, old_string, new_string, replace_all
        )

    def delete(self, file_path: str) -> DeleteResult:
        if not self._is_allowed_path(file_path, writable=True):
            return DeleteResult(error=self._path_access_error(file_path, writable=True))
        result = super().delete(self._to_container_path(file_path))
        if result.path is not None:
            result.path = file_path
        return result

    def _write_preflight(self, file_path: str) -> WriteResult | None:
        return super()._write_preflight(self._to_container_path(file_path))

    def _edit_inline(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool
    ) -> EditResult:
        result = super()._edit_inline(
            self._to_container_path(file_path), old_string, new_string, replace_all
        )
        if result.path is not None:
            result.path = file_path
        return result

    def _edit_via_upload(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool
    ) -> EditResult:
        result = super()._edit_via_upload(
            self._to_container_path(file_path), old_string, new_string, replace_all
        )
        if result.path is not None:
            result.path = file_path
        return result

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        # Defer container startup until a path passes local validation; invalid
        # tool calls should return cheap errors without paying Docker startup cost.
        initialized = False

        for target_path, content in files:
            if not is_absolute_unix_path(target_path):
                responses.append(
                    FileUploadResponse(path=target_path, error="invalid_path")
                )
                continue
            transfer_route = self._transfer_route(target_path, require_writable=True)
            if transfer_route is None:
                responses.append(
                    FileUploadResponse(path=target_path, error="permission_denied")
                )
                continue
            route_root, relative_parts = transfer_route

            try:
                if not initialized:
                    self.container.ensure_started()
                    initialized = True
                result = docker_runtime.transfer_with_container_helper(
                    container_name=self.container_name,
                    script=docker_transfer_script(
                        operation="upload",
                        root=route_root,
                        relative_parts=relative_parts,
                    ),
                    input_bytes=content,
                    timeout_ms=self.command_timeout_ms,
                )
                if result.returncode != 0:
                    responses.append(
                        FileUploadResponse(
                            path=target_path,
                            error=docker_transfer_error(result.stderr),
                        )
                    )
                    continue
                responses.append(FileUploadResponse(path=target_path, error=None))
            except Exception as error:
                responses.append(
                    FileUploadResponse(
                        path=target_path,
                        error=infer_file_operation_error(error),
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
        # Defer container startup until a path passes local validation; invalid
        # tool calls should return cheap errors without paying Docker startup cost.
        initialized = False

        for requested_path in paths:
            if not is_absolute_unix_path(requested_path):
                responses.append(
                    FileDownloadResponse(
                        path=requested_path, content=None, error="invalid_path"
                    )
                )
                continue
            transfer_route = self._transfer_route(requested_path)
            if transfer_route is None:
                responses.append(
                    FileDownloadResponse(
                        path=requested_path, content=None, error="permission_denied"
                    )
                )
                continue
            route_root, relative_parts = transfer_route

            try:
                if not initialized:
                    self.container.ensure_started()
                    initialized = True
                result = docker_runtime.transfer_with_container_helper(
                    container_name=self.container_name,
                    script=docker_transfer_script(
                        operation="download",
                        root=route_root,
                        relative_parts=relative_parts,
                    ),
                    input_bytes=None,
                    timeout_ms=self.command_timeout_ms,
                )
                if result.returncode != 0:
                    responses.append(
                        FileDownloadResponse(
                            path=requested_path,
                            content=None,
                            error=docker_transfer_error(result.stderr),
                        )
                    )
                    continue
                responses.append(
                    FileDownloadResponse(
                        path=requested_path,
                        content=result.stdout,
                        error=None,
                    )
                )
            except Exception as error:
                responses.append(
                    FileDownloadResponse(
                        path=requested_path,
                        content=None,
                        error=infer_file_operation_error(error),
                    )
                )

        return responses

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return await asyncio.to_thread(self.download_files, paths)
