import pytest
from scripts.patcheval.generation_image import validate_work_dir


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/workspace",
        "/workspace/a/b",
        "/workspace/../x",
        "/workspace/PoC_env",
        "/workspace/a\n",
    ],
)
def test_invalid_project_path_cannot_select_dependency_or_parent(path):
    with pytest.raises(ValueError):
        validate_work_dir(path)


def test_camp_is_a_project_not_a_preserved_dependency():
    assert validate_work_dir("/workspace/camp") == "camp"


def test_generation_applies_fixed_environment_without_runtime_probe(
    tmp_path, monkeypatch
):
    import json
    from types import SimpleNamespace

    from scripts.patcheval import generation_image

    configured = {
        "source_image": "sha256:source",
        "work_dir": "/workspace/project",
        "environment": {"PATH": "/workspace/PoC_env/bin:/usr/bin:/bin"},
        "preserved_workspace_siblings": ["PoC_env"],
        "removed_workspace_entries": ["fix.patch"],
    }
    environments = tmp_path / "environments.json"
    environments.write_text(json.dumps({"CVE-2023-41039": configured}))
    monkeypatch.setattr(generation_image, "ENVIRONMENTS_PATH", environments)
    monkeypatch.setenv("AGENT_DOCKER_RUN_LABEL", "attempt-test")
    calls = []

    def docker(args):
        calls.append(args)
        if args[:2] == ["image", "inspect"]:
            output = json.dumps([{"Id": configured["source_image"]}])
        elif args[0] == "inspect":
            output = '[{"State": {"ExitCode": 0}}]'
        elif args[0] == "commit":
            output = "sha256:prepared"
        else:
            output = ""
        return SimpleNamespace(stdout=output)

    monkeypatch.setattr(generation_image, "_run_docker_command", docker)
    result = generation_image.prepare_generation_image(
        SimpleNamespace(
            cve_id="CVE-2023-41039",
            work_dir=configured["work_dir"],
            image_name="fixture-image",
        )
    )
    create = next(args for args in calls if args[0] == "create")
    assert create[create.index("--label") + 1] == "sec-review.run=attempt-test"
    commit = next(args for args in calls if args[0] == "commit")
    assert "ENV PATH=" + configured["environment"]["PATH"] in commit
    assert result["environment"] == configured["environment"]
    assert result["preserved_workspace_siblings"] == ["PoC_env"]
    assert all(args[0] not in {"run", "exec"} for args in calls)
