import stat

from sec_review_agents.workspace.file_changes import collect_publishable_file_changes


def test_collect_publishable_file_changes_reads_temp_workspace_before_cleanup(
    tmp_path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "src").mkdir()
    (workspace / "src" / "app.py").write_text("print('fixed')\n", encoding="utf-8")
    (workspace / "image.bin").write_bytes(b"\x00\x01")
    (workspace / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    (workspace / "run.sh").chmod((workspace / "run.sh").stat().st_mode | stat.S_IXUSR)

    file_changes = collect_publishable_file_changes(
        workspace,
        ["src/app.py", "image.bin", "run.sh", "src/deleted.py"],
    )

    assert file_changes == [
        {
            "path": "src/app.py",
            "status": "upsert",
            "mode": "100644",
            "content": "print('fixed')\n",
            "content_encoding": "utf-8",
        },
        {
            "path": "image.bin",
            "status": "upsert",
            "mode": "100644",
            "content": "AAE=",
            "content_encoding": "base64",
        },
        {
            "path": "run.sh",
            "status": "upsert",
            "mode": "100755",
            "content": "#!/bin/sh\n",
            "content_encoding": "utf-8",
        },
        {
            "path": "src/deleted.py",
            "status": "deleted",
        },
    ]
