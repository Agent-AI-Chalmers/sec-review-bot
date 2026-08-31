import pytest

from sec_review_agents.utils.files import (
    artifact_path,
    persist_json,
    persist_text_artifact,
    safe_artifact_filename,
)


@pytest.mark.parametrize(
    "filename",
    ("", "../result.json", "nested/result.json", "/tmp/result.json", "."),
)
def test_safe_artifact_filename_rejects_path_like_values(filename: str) -> None:
    with pytest.raises(ValueError, match="plain file name"):
        safe_artifact_filename(filename)


def test_artifact_path_uses_safe_filename(tmp_path) -> None:
    assert artifact_path(tmp_path, "result.json") == tmp_path / "result.json"


def test_persist_json_rejects_path_like_filename(tmp_path) -> None:
    with pytest.raises(ValueError, match="plain file name"):
        persist_json(
            tmp_path,
            "../escaped.json",
            {"ok": True},
        )

    assert not (tmp_path.parent / "escaped.json").exists()


def test_persist_text_artifact_writes_plain_filename(tmp_path) -> None:
    path = persist_text_artifact(tmp_path, "workspace.patch", "diff\n")

    assert path == tmp_path / "workspace.patch"
    assert (tmp_path / "workspace.patch").read_text(encoding="utf-8") == "diff\n"


def test_persist_text_artifact_rejects_path_like_filename(tmp_path) -> None:
    with pytest.raises(ValueError, match="plain file name"):
        persist_text_artifact(tmp_path, "nested/workspace.patch", "diff\n")

    assert not (tmp_path / "nested" / "workspace.patch").exists()
