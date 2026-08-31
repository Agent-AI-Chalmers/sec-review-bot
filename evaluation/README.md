# Evaluation Artifacts

This directory contains the evaluation artifacts used by the repository's paper experiments.

## Contents

- [cve-issue/](cve-issue/) contains the PatchEval CVE repair evaluation inputs,
  submitted patch JSON files, official evaluator summaries, and quality notes.
- [repo-full-scan-case/](repo-full-scan-case/) contains full-repository security
  scan case studies for public benchmark repositories under
  `Agent-AI-Chalmers`, including agent reports and Semgrep, CodeQL, and ZAP
  baseline outputs.

## Source and License Notes

- The PatchEval runtime subset is based on a fork/local copy of the public
  [Agent-AI-Chalmers/PatchEval](https://github.com/Agent-AI-Chalmers/PatchEval)
  project, with minor local adjustments for this evaluation. PatchEval is
  distributed under the Apache-2.0 license.
- PatchEval records include CVE metadata, upstream repository references, code
  snippets, and patch metadata from the affected open-source projects. Those
  records are included here only as evaluation data for reproducibility.
- The repository full-scan case studies target public benchmark repositories
  listed in [repo-full-scan-case/README.md](repo-full-scan-case/README.md).

## Public Artifact Hygiene

These artifacts may contain synthetic credentials, localhost URLs, test account names, scanner evidence, and intentionally vulnerable code snippets. They are part of the benchmark material and are not production secrets.

Personal Semgrep organization URLs have been redacted from exported Semgrep CSV files. Finding IDs, rule IDs, repository URLs, and source-location URLs are kept so the scanner baselines remain inspectable.
