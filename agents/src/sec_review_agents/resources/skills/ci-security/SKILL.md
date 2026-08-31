---
name: ci-security
description: "Use as a narrow reference for CI/CD security source/sink analysis and attack precedents, especially GitHub Actions and GitLab CI workflows."
---

# CI Security Reference Skill

Use this skill when the reviewed lead involves CI/CD workflows, local actions, workflow-triggered scripts, repository automation, or artifacts crossing trust boundaries.

Do not use this skill as a CI hardening checklist. A finding must still have a concrete exploitation path, attacker-controlled input or untrusted artifact, a reachable privileged sink, and a repository-grounded impact.

## Route

- For GitHub Actions workflows, composite actions, local actions, `pull_request_target`, `workflow_run`, workflow command/script injection, artifact trust boundaries, mutable checkout refs, approval/comment gates, permissions, or secrets: read `/skills/ci-security/references/github-actions.md`.
- For GitLab CI pipelines, `.gitlab-ci.yml`, merge request pipelines, fork pipelines, protected variables/runners, CI job tokens, trigger tokens, or untrusted artifacts crossing pipeline boundaries: read `/skills/ci-security/references/gitlab-ci.md`.

If the concern is only "best practice missing" such as unpinned actions, absent CodeQL, missing Dependabot, broad workflow hygiene, or non-minimal permissions with no exploit-relevant path, keep it non-confirmed unless repository evidence shows concrete impact.

## Use Rules

- Use the reference to trace source -> sink -> privilege/secret boundary.
- Do not report CI issues from keywords alone; require a specific triggering event, attacker role, and privileged effect.
- Keep repository workflow findings separate from GitHub App or GitLab project permission concerns unless the provided materials include those permissions.
