# CI Security Skill Source Notes

These sources support the `ci-security` bundled skill references. Primary sources should be preferred when changing agent-facing content. Third-party skill examples may be retained as inspiration, but they are not authoritative security sources.

## github-actions

Primary sources:

- https://docs.github.com/en/actions/concepts/security/script-injections
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/
- https://cheatsheetseries.owasp.org/cheatsheets/GitHub_Actions_Security_Cheat_Sheet.html

Claim ledger:

- Claim: GitHub event context and expression values can be attacker controlled and can become script injection when interpolated into `run:` scripts.
  Primary source: GitHub Docs script injections.
  Adoption note: Agent-facing guidance requires a concrete source-to-shell/script path, not keyword matching.
- Claim: `pull_request_target` is privileged relative to untrusted fork code and is dangerous when it checks out or executes attacker-controlled PR content.
  Primary source: GitHub Docs event warning; GitHub Security Lab pwn request examples.
  Adoption note: The reference also keeps the false-positive precedent that `pull_request_target` alone is not exploitable.
- Claim: `workflow_run` can access secrets/write token even when the triggering workflow was unprivileged.
  Primary source: GitHub Docs `workflow_run` warning.
  Adoption note: The reference treats `workflow_run` as a privileged boundary only when untrusted code/artifacts get a privileged effect.
- Claim: Artifacts from untrusted PR workflows remain untrusted in privileged workflows, but inert data such as PR numbers or coverage text can be used safely.
  Primary source: GitHub Security Lab "Preventing pwn requests".
  Adoption note: The reference must not require cryptographic binding as a standalone vulnerability condition.
- Claim: Missing hardening items such as CodeQL, Dependabot, pinning, or minimal permissions are not findings without a reachable exploit path.
  Primary source: Project evidence-discipline policy, with GitHub hardening docs as background.
  Adoption note: This is a project-specific false-positive precedent, not a direct GitHub vulnerability rule.

Inspiration sources:

- https://skillsmp.com/skills/getsentry-skills-plugins-sentry-skills-skills-gha-security-review-skill-md
- https://skillsmp.com/skills/github-gh-aw-skills-developer-skill-md
- https://skillsmp.com/skills/mkspwr12-options-scanner-frontend-github-skills-operations-github-actions-workflows-skill-md

## gitlab-ci

Primary sources:

- https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/
- https://docs.gitlab.com/ci/variables/
- https://docs.gitlab.com/ci/jobs/ci_job_token/
- https://docs.gitlab.com/ci/pipelines/pipeline_security/
- https://docs.gitlab.com/user/project/repository/branches/protected/

Claim ledger:

- Claim: Ordinary fork merge request pipelines are created and run in the fork project and use the fork project's CI/CD configuration, resources, and variables.
  Primary source: GitLab merge request pipelines docs, "Use with forked projects".
  Adoption note: Do not report parent-variable exposure from ordinary fork MR pipeline behavior alone.
- Claim: Parent-project pipelines for fork merge requests run in the parent project, use the CI/CD configuration from the fork branch, and use parent project settings/resources/variables plus triggering member permissions.
  Primary source: GitLab merge request pipelines docs, "Run pipelines in the parent project".
  Adoption note: This is the main GitLab fork-to-parent trust boundary to inspect.
- Claim: Protected variables and protected runners have separate protected-resource access conditions; fork merge request pipelines cannot access protected resources.
  Primary source: GitLab merge request pipelines docs, "Control access to protected variables and runners"; GitLab CI/CD variables docs.
  Adoption note: Keep general parent-project variables/resources distinct from protected variables/runners.
- Claim: `CI_JOB_TOKEN`, trigger tokens, deploy credentials, artifacts, and caches matter when untrusted pipeline data can influence a privileged job.
  Primary source: GitLab CI job token docs and GitLab pipeline security docs.
  Adoption note: Require attacker role, source-to-sink path, and concrete privileged effect.
