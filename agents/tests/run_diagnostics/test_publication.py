from pathlib import Path

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.run_diagnostics.bundle import PublishedDiagnosticBundle
from sec_review_agents.run_diagnostics.publication import (
    RunDiagnosticPublicationRequest,
    publish_run_diagnostic_activity,
)


def test_publication_activity_uses_publisher_unit_ids(
    tmp_path: Path, monkeypatch
) -> None:
    """The activity must not re-glob transcripts and drift from the manifest."""
    empty = tmp_path / "empty"
    (empty / "0001-fake.jsonl").mkdir(parents=True)
    reference = ArtifactReference(
        uri="file:///tmp/diagnostic-tree.v1.tar.zst",
        digest=f"sha256:{'a' * 64}",
        media_type="application/tar+zstd",
        size_bytes=42,
    )
    publication = PublishedDiagnosticBundle(
        reference=reference,
        unit_ids=("case-a",),
    )
    monkeypatch.setattr(
        "sec_review_agents.run_diagnostics.bundle.publish_run_diagnostic_bundle",
        lambda **_kwargs: publication,
    )

    result = publish_run_diagnostic_activity(
        RunDiagnosticPublicationRequest(
            run_id="run-1",
            artifact_root_path=str(tmp_path / "artifacts"),
            review_units=[
                {"unit_id": "empty", "transcript_root": str(empty)},
            ],
            result={},
            publication="local",
        )
    )

    assert result["unit_ids"] == ["case-a"]
