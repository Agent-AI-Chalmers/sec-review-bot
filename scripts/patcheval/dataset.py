import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

type PatchevalIssueMode = Literal["end_to_end", "location_oracle"]


class PatchevalDatasetError(RuntimeError):
    """Raised when PatchEval dataset files are missing or inconsistent."""


@dataclass(frozen=True)
class PatchevalCase:
    cve_id: str
    repo: str
    programming_language: str
    cve_description: str
    cwe_info: dict[str, Any]
    vul_func: list[dict[str, Any]]
    fix_func: list[dict[str, Any]]
    image_name: str
    work_dir: str
    poc_test_cmd: str | None
    unit_test_cmd: str | None

    @property
    def repo_name(self) -> str:
        normalized = self.repo.rstrip("/")
        return normalized.rsplit("/", 1)[-1]

    @property
    def short_description(self) -> str:
        description = " ".join(self.cve_description.split())
        if not description:
            return f"fix vulnerability in {self.repo_name}"
        sentence = description.split(". ", 1)[0].rstrip(".")
        return sentence[:160].rstrip()

    def issue_title(self, mode: PatchevalIssueMode = "end_to_end") -> str:
        if mode == "location_oracle":
            return f"Fix vulnerability in {self.repo_name}"
        return self.short_description

    def issue_body(self, mode: PatchevalIssueMode = "end_to_end") -> str:
        parts = [self._description_block()]
        if self.cwe_info:
            parts.append(self._cwe_block())
        if mode == "location_oracle":
            oracle_block = self._location_oracle_block()
            if oracle_block:
                parts.append(oracle_block)
        return "\n\n".join(part for part in parts if part)

    def _description_block(self) -> str:
        description = self.cve_description.strip()
        for index, char in enumerate(description):
            if char != "{":
                continue
            try:
                parsed = json.loads(description[index:])
            except json.JSONDecodeError:
                continue
            if (
                isinstance(parsed, dict)
                and parsed
                and all(str(key).startswith("CWE-") for key in parsed)
            ):
                return description[:index].strip()
        return description

    def _cwe_block(self) -> str:
        lines = ["CWE:"]
        for cwe_id, cwe in self.cwe_info.items():
            name = cwe.get("name") if isinstance(cwe, dict) else None
            if name:
                lines.append(f"- {cwe_id}: {name}")
            else:
                lines.append(f"- {cwe_id}")
        return "\n".join(lines)

    def _location_oracle_block(self) -> str:
        if not self.vul_func:
            return ""

        lines = ["Vulnerability location:"]
        for func in self.vul_func:
            file_path = str(func.get("file_path") or "").strip() or "<unknown>"
            start_line = func.get("start_line")
            end_line = func.get("end_line")
            location = file_path
            if isinstance(start_line, int) and isinstance(end_line, int):
                location = f"{file_path}:{start_line}-{end_line}"
            elif isinstance(start_line, int):
                location = f"{file_path}:{start_line}"
            lines.append(f"- {location}")
        return "\n".join(lines)


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise PatchevalDatasetError(
            f"PatchEval dataset file not found: {path}"
        ) from error
    except json.JSONDecodeError as error:
        raise PatchevalDatasetError(
            f"Invalid JSON in PatchEval dataset file {path}: {error}"
        ) from error


def _find_case(dataset_path: Path, cve_id: str) -> dict[str, Any]:
    data = _load_json(dataset_path)
    if not isinstance(data, list):
        raise PatchevalDatasetError(f"Expected a JSON array in {dataset_path}")

    for item in data:
        if isinstance(item, dict) and item.get("cve_id") == cve_id:
            return item

    raise PatchevalDatasetError(f"CVE not found in PatchEval dataset: {cve_id}")


def load_patcheval_case(
    *,
    cve_id: str,
    dataset_path: str | Path,
) -> PatchevalCase:
    """
    Load a PatchEval case by CVE id from a single enriched runtime-subset dataset file.
    """
    case = _find_case(Path(dataset_path), cve_id)

    image_name = str(case.get("image_name") or "").strip()
    work_dir = str(case.get("work_dir") or "").strip()
    if not image_name or not work_dir:
        raise PatchevalDatasetError(
            f"PatchEval case metadata for {cve_id} is incomplete: image_name={image_name!r}, work_dir={work_dir!r}"
        )

    return PatchevalCase(
        cve_id=str(case.get("cve_id") or cve_id),
        repo=str(case.get("repo") or "").strip(),
        programming_language=str(case.get("programming_language") or "").strip(),
        cve_description=str(case.get("cve_description") or "").strip(),
        cwe_info=dict(case.get("cwe_info") or {}),
        vul_func=list(case.get("vul_func") or []),
        fix_func=list(case.get("fix_func") or []),
        image_name=image_name,
        work_dir=work_dir,
        poc_test_cmd=case.get("poc_test_cmd"),
        unit_test_cmd=case.get("unit_test_cmd"),
    )
