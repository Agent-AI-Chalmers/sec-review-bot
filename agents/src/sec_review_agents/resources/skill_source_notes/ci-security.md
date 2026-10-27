# CI Security Skill Source Notes

These sources support the `ci-security` references.

## github-actions

Primary sources:

- <https://docs.github.com/en/actions/concepts/security/script-injections>
- <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions>
- <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>
- <https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/>
- <https://cheatsheetseries.owasp.org/cheatsheets/GitHub_Actions_Security_Cheat_Sheet.html>

Claim ledger:

- Claim: GitHub event context and expression values can be attacker controlled and can become script injection when interpolated into `run:` scripts.
  Primary source: GitHub Docs script injections.
  Limit: An untrusted context value is not a finding unless it reaches a script interpreter or another security-relevant consumer.
- Claim: `pull_request_target` is privileged relative to untrusted fork code and is dangerous when it checks out or executes attacker-controlled PR content.
  Primary source: GitHub Docs event warning; GitHub Security Lab pwn request examples.
  Limit: The event alone is insufficient; attacker-controlled content must reach a privileged operation.
- Claim: `workflow_run` can access secrets/write token even when the triggering workflow was unprivileged.
  Primary source: GitHub Docs `workflow_run` warning.
  Limit: Require a path from untrusted code or artifacts to the privileged follow-up workflow.
- Claim: Artifacts from untrusted PR workflows remain untrusted in privileged workflows, but inert data such as PR numbers or coverage text can be used safely.
  Primary source: GitHub Security Lab "Preventing pwn requests".
  Limit: Artifact use is not unsafe when the consumed data is inert and cannot alter a privileged operation.

## gitlab-ci

Primary sources:

- <https://docs.gitlab.com/ci/pipelines/merge_request_pipelines/>
- <https://docs.gitlab.com/ci/variables/>
- <https://docs.gitlab.com/ci/jobs/ci_job_token/>
- <https://docs.gitlab.com/ci/pipelines/pipeline_security/>
- <https://docs.gitlab.com/user/project/repository/branches/protected/>

Claim ledger:

- Claim: Ordinary fork merge request pipelines are created and run in the fork project and use the fork project's CI/CD configuration, resources, and variables.
  Primary source: GitLab merge request pipelines docs, "Use with forked projects".
  Limit: Ordinary fork-project execution does not by itself expose parent-project variables.
- Claim: Parent-project pipelines for fork merge requests run in the parent project, use the CI/CD configuration from the fork branch, and use parent project settings/resources/variables plus triggering member permissions.
  Primary source: GitLab merge request pipelines docs, "Run pipelines in the parent project".
  Limit: Verify that the parent-project pipeline is actually created and which member triggers it.
- Claim: Protected variables and protected runners have separate protected-resource access conditions; fork merge request pipelines cannot access protected resources.
  Primary source: GitLab merge request pipelines docs, "Control access to protected variables and runners"; GitLab CI/CD variables docs.
  Limit: General parent-project resources and protected resources have different access conditions.
- Claim: `CI_JOB_TOKEN`, trigger tokens, deploy credentials, artifacts, and caches matter when untrusted pipeline data can influence a privileged job.
  Primary source: GitLab CI job token docs and GitLab pipeline security docs.
  Limit: Token or artifact presence alone does not establish attacker access or privileged consumption.

## secret-and-artifact-exposure

Primary sources:

- <https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions>
- <https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts>
- <https://docs.gitlab.com/ci/variables/>
- <https://docs.gitlab.com/ci/jobs/job_artifacts/>
- <https://docs.docker.com/build/building/secrets/>

Claim ledger:

- Claim: Log masking is limited to values the platform recognizes and does not protect files, transformed values, artifacts, caches, or deliberate exfiltration by code that can read a secret.
  Primary source: GitHub Actions secrets docs; GitLab CI/CD variables docs.
  Limit: Masking limitations do not prove that a secret reaches an unauthorized sink.
- Claim: Build artifacts have explicit readers and retention behavior that must be checked before calling an uploaded file public or unauthorized.
  Primary source: GitHub artifact docs; GitLab job artifacts docs.
  Limit: Artifact upload alone does not establish unauthorized access.
- Claim: Build arguments and environment variables can persist in image metadata or layers and are unsuitable for build secrets; secret mounts avoid persisting the secret as build input.
  Primary source: Docker Build secrets docs.
  Limit: Verify the actual builder and published layers. A Dockerfile keyword alone is insufficient.
