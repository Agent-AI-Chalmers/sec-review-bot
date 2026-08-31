# GitLab CI Reference

Use this reference for GitLab CI/CD pipelines, merge request pipelines, fork pipelines, protected variables or runners, CI job tokens, trigger tokens, pipeline artifacts, caches, and deployment jobs crossing trust boundaries.

## Sources

- `.gitlab-ci.yml`, included CI templates, local scripts, Dockerfiles, package scripts, Makefiles, and deployment helpers invoked by jobs.
- Untrusted merge request metadata, branch names, commit messages, pipeline variables, trigger inputs, schedules, webhooks, artifacts, caches, coverage reports, generated files, dependency outputs, or fork project code.
- Merge request pipelines and parent-project pipelines for fork merge requests, especially when a maintainer manually starts a parent-project pipeline.
- Protected variables, protected runners, deploy tokens, trigger tokens, secure files, registry credentials, cloud credentials, and `CI_JOB_TOKEN`.
- Mutable refs, tags, branch names, or untrusted SHAs used for checkout, release, package, deploy, or trust decisions.

## Sinks

- Shell jobs that interpolate untrusted variables or metadata into `script`, `before_script`, `after_script`, or helper scripts.
- Jobs that expose secrets, protected variables, protected runners, deployment credentials, registry credentials, secure files, or cloud credentials to untrusted code.
- Jobs using `CI_JOB_TOKEN`, trigger tokens, deploy tokens, package publishing, release creation, repository mutation, cross-project API calls, or deployment actions.
- Artifact download, extraction, sourcing, execution, publishing, or use as a trusted report after an untrusted pipeline produced the artifact.
- Cache restore/save paths where attacker-controlled content can poison a later privileged job.

## Guards

- Treat ordinary fork merge request pipelines as untrusted fork-context pipelines. They run in the fork project and use the fork project's CI/CD configuration, resources, and variables.
- Treat parent-project pipelines for fork merge requests as privileged parent-context pipelines. They run in the parent project, use CI/CD configuration from the fork branch, and use the parent project's CI/CD settings, resources, variables, and triggering member permissions.
- Treat protected variables and protected runners as a separate protected-resource boundary. Access depends on GitLab's protected-resource conditions, such as protected source and target branches, same-project branch ownership, triggering user permissions, and project settings.
- Use protected variables, protected branches/tags, protected environments, and restricted runners to keep deployment and release credentials away from untrusted jobs.
- Scope `CI_JOB_TOKEN`, trigger tokens, deploy tokens, and cross-project access to the minimum project/resource needed.
- Treat artifacts and caches from lower-trust jobs as data. Do not execute, source, publish, or trust them in privileged jobs without binding them to the reviewed commit and safely parsing them.
- Pin trust decisions to immutable commit SHAs rather than mutable branch names or tags when a privileged job will release, deploy, or mutate repositories.

## Report Conditions

- State the attacker role: fork contributor, merge request author, project member without protected-branch access, pipeline trigger user, compromised dependency, or other concrete actor.
- Trace untrusted source or artifact to a privileged CI sink.
- Explain why existing branch protection, protected variable, runner, environment, token, approval, or manual gate controls do not break the path.
- Identify the privileged effect: secret exposure, protected runner misuse, repository or package mutation, deployment, cross-project API access, cache poisoning, or command execution in a trusted pipeline context.

## False-Positive Precedents

- A `.gitlab-ci.yml` file, `rules`, `only`, `except`, protected variable, or `CI_JOB_TOKEN` keyword is not enough. Tie it to a concrete attack path.
- Merge request pipelines are not automatically vulnerable; GitLab has distinct trust behavior for fork pipelines, parent-project pipelines, protected variables, protected runners, and protected branches.
- Ordinary fork merge request pipelines do not use the parent project's CI/CD variables, settings, runners, or resources.
- Parent-project pipelines for fork merge requests can use parent-project CI/CD settings, resources, variables, and triggering member permissions, while still using CI/CD configuration from the fork branch.
- Protected variables and protected runners have narrower access rules than general parent-project variables/resources. Fork merge request pipelines cannot access protected resources, and same-project merge request pipelines require the documented protected branch and permission conditions.
- A manual pipeline gate is not automatically safe or unsafe. Check who can trigger it, what commit/artifact it uses, and whether the privileged step revalidates that target.
- Broad CI hygiene issues such as missing SAST, unpinned images, or broad cache use are hardening concerns unless paired with a reachable exploit-relevant path.
