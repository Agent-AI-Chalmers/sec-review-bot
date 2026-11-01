"""Upstream local file operations with project mount permissions."""

from pathlib import Path

from deepagents.backends import FilesystemBackend
from deepagents.backends.protocol import (
    DeleteResult,
    EditResult,
    FileUploadResponse,
    WriteResult,
)


class LocalFilesystemBackend(FilesystemBackend):
    def __init__(self, root_dir: str | Path, *, writable: bool = True) -> None:
        super().__init__(root_dir=str(root_dir), virtual_mode=True)
        self.root_dir = self.cwd
        self.writable = writable

    def delete(self, file_path: str) -> DeleteResult:
        if not self.writable:
            return DeleteResult(error=f"Deletes are not allowed under {file_path}")
        try:
            # Upstream resolves links before deletion; reject linked paths so
            # deleting a link cannot remove its target (deepagents PR #7015).
            unresolved = self.cwd / file_path.lstrip("/")
            self._resolve_path(file_path)
            for path in (unresolved, *unresolved.parents):
                if path == self.root_dir:
                    break
                if path.is_symlink():
                    return DeleteResult(
                        error="Deleting through symlinks is not allowed"
                    )
            return super().delete(file_path)
        except (OSError, ValueError, RuntimeError) as error:
            return DeleteResult(
                error=f"Cannot delete '{file_path}': {type(error).__name__}"
            )

    def write(self, file_path: str, content: str) -> WriteResult:
        if not self.writable:
            return WriteResult(error=f"Writes are not allowed under {file_path}")
        return super().write(file_path, content)

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        if not self.writable:
            return EditResult(error=f"Edits are not allowed under {file_path}")
        return super().edit(file_path, old_string, new_string, replace_all)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        if not self.writable:
            return [
                FileUploadResponse(path=path, error="permission_denied")
                for path, _ in files
            ]
        return super().upload_files(files)
