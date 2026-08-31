import json
from pathlib import Path


class PatchevalSubmissionError(RuntimeError):
    """Raised when PatchEval submission artifacts cannot be generated."""


def build_patch_submission_record(*, cve_id: str, fix_patch: str) -> dict[str, str]:
    patch_text = str(fix_patch or "")
    if not patch_text.strip():
        raise PatchevalSubmissionError(
            f"Cannot build PatchEval submission record for {cve_id}: fix_patch is empty."
        )
    return {
        "cve": cve_id,
        "fix_patch": patch_text,
    }


def write_patch_submission_file(
    *,
    cve_id: str,
    fix_patch: str,
    output_path: str | Path,
) -> Path:
    record = build_patch_submission_record(cve_id=cve_id, fix_patch=fix_patch)
    output_path = Path(output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps([record], indent=2), encoding="utf-8")
    return output_path
