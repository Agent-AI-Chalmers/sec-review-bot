import base64
import errno
import json
import os
import stat
import sys

payload = json.loads(base64.b64decode("__PAYLOAD_B64__"))
operation = payload["operation"]
root = payload["root"]
parts = payload["parts"]

directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
try:
    current_fd = os.open(root, directory_flags)
    try:
        # Keep the directory chain open so concurrent renames or symlink swaps
        # cannot redirect the final open outside the selected route root.
        for part in parts[:-1]:
            try:
                next_fd = os.open(part, directory_flags, dir_fd=current_fd)
            except FileNotFoundError:
                if operation != "upload":
                    raise
                try:
                    os.mkdir(part, mode=0o777, dir_fd=current_fd)
                except FileExistsError:
                    pass
                next_fd = os.open(part, directory_flags, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd

        filename = parts[-1] if parts else "."
        if operation == "upload":
            flags = (
                os.O_WRONLY
                | os.O_CREAT
                | os.O_TRUNC
                | os.O_NOFOLLOW
                | os.O_NONBLOCK
                | os.O_CLOEXEC
            )
            fd = os.open(filename, flags, 0o666, dir_fd=current_fd)
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                os.close(fd)
                raise OSError(errno.EACCES, "non-regular transfer target", filename)
            with os.fdopen(fd, "wb") as handle:
                while chunk := sys.stdin.buffer.read(1024 * 1024):
                    handle.write(chunk)
        elif operation == "download":
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
            fd = os.open(filename, flags, dir_fd=current_fd)
            mode = os.fstat(fd).st_mode
            if not stat.S_ISREG(mode):
                os.close(fd)
                if stat.S_ISDIR(mode):
                    raise IsADirectoryError(filename)
                raise OSError(errno.EACCES, "non-regular transfer target", filename)
            with os.fdopen(fd, "rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    sys.stdout.buffer.write(chunk)
        else:
            raise ValueError(f"unknown transfer operation: {operation}")
    finally:
        os.close(current_fd)
except OSError as error:
    if error.errno == errno.ENOENT:
        kind = "file_not_found"
    elif error.errno == errno.EISDIR:
        kind = "is_directory"
    elif error.errno in {
        errno.EACCES,
        errno.EAGAIN,
        errno.ELOOP,
        errno.ENOTDIR,
        errno.ENXIO,
        errno.EROFS,
    }:
        kind = "permission_denied"
    else:
        kind = "invalid_path"
    sys.stderr.write(f"SEC_REVIEW_TRANSFER_ERROR:{kind}\n")
    raise SystemExit(1)
