import hashlib
import json
import tarfile
from pathlib import Path

from sec_review_agents.contract_versions import EXECUTION_API_VERSION


def _canonical_tar_info(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mode = 0o755 if info.isdir() else 0o644
    return info


def write_test_input_bundle(
    root: Path, *, include_manifest: bool = True
) -> dict[str, object]:
    root.mkdir(parents=True, exist_ok=True)
    if include_manifest:
        (root / "manifest.json").write_text(
            json.dumps(
                {
                    "api_version": EXECUTION_API_VERSION,
                    "workspace": {"snapshot": "workspace.snapshot.tar"},
                    "history": {"path": "history"},
                }
            ),
            encoding="utf-8",
        )
    (root / "workspace.snapshot.tar").touch()
    (root / "history").mkdir(exist_ok=True)
    archive_path = Path(f"{root}.tar.zst")
    with tarfile.open(archive_path, mode="w:zst", format=tarfile.PAX_FORMAT) as archive:
        for name in ["manifest.json", "history", "workspace.snapshot.tar"]:
            entry = root / name
            if entry.exists():
                archive.add(entry, arcname=name, filter=_canonical_tar_info)
    content = archive_path.read_bytes()
    return {
        "uri": archive_path.as_uri(),
        "digest": f"sha256:{hashlib.sha256(content).hexdigest()}",
        "media_type": "application/tar+zstd",
        "size_bytes": len(content),
    }
