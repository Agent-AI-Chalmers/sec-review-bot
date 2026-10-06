import hashlib
import json
import tarfile
from pathlib import Path


def write_test_input_bundle(
    root: Path, *, include_manifest: bool = True
) -> dict[str, object]:
    root.mkdir(parents=True, exist_ok=True)
    if include_manifest:
        (root / "manifest.json").write_text(
            json.dumps(
                {
                    "contract_version": "v5",
                    "kind": "runner-input-bundle",
                    "workspace": {"snapshot": "workspace.snapshot.tar"},
                    "history": {"path": "history"},
                }
            ),
            encoding="utf-8",
        )
    (root / "workspace.snapshot.tar").touch()
    (root / "history").mkdir(exist_ok=True)
    archive_path = Path(f"{root}.tar.zst")
    with tarfile.open(archive_path, mode="w:zst") as archive:
        for entry in root.iterdir():
            archive.add(entry, arcname=entry.name)
    content = archive_path.read_bytes()
    return {
        "uri": archive_path.as_uri(),
        "digest": f"sha256:{hashlib.sha256(content).hexdigest()}",
        "media_type": "application/vnd.sec-review.input-bundle.v1+tar+zstd",
        "size_bytes": len(content),
    }
