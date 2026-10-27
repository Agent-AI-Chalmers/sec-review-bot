"""Validation for the repository's restricted POSIX PAX tar+zstd envelope."""

from compression import zstd
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

_BLOCK_SIZE = 512
_PAX_TYPE = b"x"
_REJECTED_EXTENSION_TYPES = {b"g", b"L", b"K", b"S"}
_MAX_PAX_HEADER_BYTES = 1024 * 1024


@dataclass(frozen=True)
class TarEnvelopeEntry:
    path: str
    type_flag: bytes
    size: int
    mode: int
    uid: int
    gid: int
    mtime: int
    uname: str
    gname: str


class _BinaryReader(Protocol):
    def read(self, size: int = -1) -> bytes: ...


def _field(block: bytes, offset: int, length: int) -> bytes:
    return block[offset : offset + length].split(b"\0", 1)[0]


def _octal(block: bytes, offset: int, length: int) -> int:
    value = _field(block, offset, length).strip(b" \0")
    if not value or any(byte not in b"01234567" for byte in value):
        raise ValueError("Artifact archive contains an invalid tar numeric field.")
    return int(value, 8)


def _header_path(block: bytes) -> str:
    try:
        name = _field(block, 0, 100).decode("utf-8")
        prefix = _field(block, 345, 155).decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("Artifact archive contains a non-UTF-8 tar path.") from error
    return f"{prefix}/{name}" if prefix else name


def _text_field(block: bytes, offset: int, length: int) -> str:
    try:
        return _field(block, offset, length).decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("Artifact archive contains non-UTF-8 tar metadata.") from error


def _parse_pax_path(body: bytes) -> str:
    position = 0
    path: str | None = None
    while position < len(body):
        space = body.find(b" ", position)
        if space < 0 or not body[position:space].isdigit():
            raise ValueError("Artifact archive contains malformed PAX metadata.")
        length = int(body[position:space])
        end = position + length
        if length <= space - position + 2 or end > len(body) or body[end - 1] != 0x0A:
            raise ValueError("Artifact archive contains malformed PAX metadata.")
        record = body[space + 1 : end - 1]
        key, separator, value = record.partition(b"=")
        if separator != b"=" or key != b"path" or path is not None:
            raise ValueError("Artifact archive contains unsupported PAX metadata.")
        try:
            path = value.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(
                "Artifact archive contains a non-UTF-8 PAX path."
            ) from error
        position = end
    if path is None:
        raise ValueError("Artifact archive PAX header has no path.")
    return path


def _read_exact(source: _BinaryReader, size: int) -> bytes:
    value = source.read(size)
    if len(value) != size:
        raise ValueError("Artifact archive contains truncated tar data.")
    return value


def _discard_exact(source: _BinaryReader, size: int) -> None:
    remaining = size
    while remaining:
        chunk = source.read(min(remaining, 1024 * 1024))
        if not chunk:
            raise ValueError("Artifact archive contains truncated tar data.")
        remaining -= len(chunk)


def validate_restricted_pax_archive(archive_path: Path) -> tuple[TarEnvelopeEntry, ...]:
    """Validate raw headers that high-level tar readers commonly hide."""
    entries: list[TarEnvelopeEntry] = []
    pending_path: str | None = None
    terminated = False
    with zstd.open(archive_path, "rb") as source:
        while header := source.read(_BLOCK_SIZE):
            if len(header) != _BLOCK_SIZE:
                raise ValueError("Artifact archive contains a partial tar header.")
            if not any(header):
                if any(_read_exact(source, _BLOCK_SIZE)):
                    raise ValueError("Artifact archive has an invalid tar terminator.")
                terminated = True
                break
            if _field(header, 257, 6) != b"ustar":
                raise ValueError("Artifact archive entry is not POSIX PAX/ustar.")
            stored_checksum = _octal(header, 148, 8)
            checksum_header = bytearray(header)
            checksum_header[148:156] = b" " * 8
            if sum(checksum_header) != stored_checksum:
                raise ValueError("Artifact archive tar checksum is invalid.")
            size = _octal(header, 124, 12)
            padded_size = ((size + _BLOCK_SIZE - 1) // _BLOCK_SIZE) * _BLOCK_SIZE
            type_flag = _field(header, 156, 1) or b"0"
            if type_flag in _REJECTED_EXTENSION_TYPES:
                raise ValueError(
                    "Artifact archive contains an unsupported tar extension."
                )
            if type_flag == _PAX_TYPE:
                if pending_path is not None:
                    raise ValueError(
                        "Artifact archive contains consecutive PAX headers."
                    )
                if size > _MAX_PAX_HEADER_BYTES:
                    raise ValueError(
                        "Artifact archive PAX header exceeds the size limit."
                    )
                body = _read_exact(source, size)
                _discard_exact(source, padded_size - size)
                pending_path = _parse_pax_path(body)
                continue
            _discard_exact(source, padded_size)
            entries.append(
                TarEnvelopeEntry(
                    path=(
                        pending_path
                        if pending_path is not None
                        else _header_path(header)
                    ),
                    type_flag=type_flag,
                    size=size,
                    mode=_octal(header, 100, 8),
                    uid=_octal(header, 108, 8),
                    gid=_octal(header, 116, 8),
                    mtime=_octal(header, 136, 12),
                    uname=_text_field(header, 265, 32),
                    gname=_text_field(header, 297, 32),
                )
            )
            pending_path = None
        if terminated:
            while chunk := source.read(1024 * 1024):
                if any(chunk):
                    raise ValueError("Artifact archive has trailing tar data.")
    if pending_path is not None:
        raise ValueError("Artifact archive contains an orphan PAX header.")
    if not terminated:
        raise ValueError("Artifact archive has trailing tar data.")
    return tuple(entries)


__all__ = ["TarEnvelopeEntry", "validate_restricted_pax_archive"]
