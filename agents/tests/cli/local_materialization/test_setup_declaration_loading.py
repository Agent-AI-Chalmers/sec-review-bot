import pytest

from sec_review_agents.cli.local_materialization.common import (
    load_setup_declaration_content,
)

_DECLARATION = "setup:\n  - run: echo hi\n"


def test_returns_none_without_a_path(monkeypatch, capsys) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "local")
    assert load_setup_declaration_content(None) is None
    assert capsys.readouterr().err == ""


def test_docker_reads_the_file(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    path = tmp_path / "setup.yml"
    path.write_text(_DECLARATION, encoding="utf-8")
    assert load_setup_declaration_content(path) == _DECLARATION


def test_docker_unreadable_path_is_an_error(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    with pytest.raises(ValueError, match="Unable to read setup declaration file"):
        load_setup_declaration_content(tmp_path / "missing.yml")


@pytest.mark.parametrize("backend", ["local", "bwrap"])
def test_non_docker_warns_and_ignores(monkeypatch, tmp_path, capsys, backend) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", backend)
    path = tmp_path / "setup.yml"
    path.write_text(_DECLARATION, encoding="utf-8")
    assert load_setup_declaration_content(path) is None
    err = capsys.readouterr().err
    assert "SETUP_DECLARATION_WARNING" in err
    assert backend in err


@pytest.mark.parametrize("backend", ["local", "bwrap"])
def test_non_docker_does_not_read_so_missing_path_does_not_raise(
    monkeypatch, tmp_path, capsys, backend
) -> None:
    # The declaration cannot run on this backend, so an unreadable path must not
    # fail the run -- only warn.
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", backend)
    assert load_setup_declaration_content(tmp_path / "missing.yml") is None
    assert "SETUP_DECLARATION_WARNING" in capsys.readouterr().err


def test_docker_blank_file_means_no_declaration(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    path = tmp_path / "setup.yml"
    path.write_text("   \n\n", encoding="utf-8")
    assert load_setup_declaration_content(path) is None


def test_docker_invalid_declaration_is_an_error(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("AGENT_SANDBOX_BACKEND", "docker")
    path = tmp_path / "setup.yml"
    path.write_text("setup:\n  - uses: actions/checkout@v4\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Invalid setup declaration file"):
        load_setup_declaration_content(path)
