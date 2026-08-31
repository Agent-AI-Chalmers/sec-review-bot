# Agent Capability Boundaries

Language: English | [中文](CAPABILITY_BOUNDARIES.zh.md)

Agents handle security issues in the repository they receive for a run when the fix can be expressed as a patch. They do not handle git-history governance, external system state, or security operations work that requires organizational coordination.

## System Scope Mapping

By default, agents handle issues they can see and change inside the repository: vulnerabilities in source code, security-relevant repository configuration, and security defects that can be fixed through repository-local controls.

The following issues can enter automatic repair candidacy:

- application-layer vulnerabilities in current source code, such as injection, authorization, unsafe data exposure, and input handling issues
- security-relevant configuration flaws in current repository files, such as Dockerfiles using the default root user, unsafe framework defaults, or missing security header configuration
- hardcoded secrets, credential samples, or dangerous defaults still present in current source code
- leaks or misconfiguration that can be prevented from continuing through a current-file patch

The following issues are not fully handleable by agents and should at most be expressed as manual follow-up, residual risk, or out-of-automation-scope work:

- secrets, sensitive files, or historical artifacts that exist only in git history
- secret rotation, token revocation, credential invalidation
- force push, history purge, fork cleanup, cache purge
- cleanup of historical copies in published packages, container images, CI logs, registries, or deployment environments
- OS, network protocol, cloud infrastructure, or deployment environment governance
- comprehensive secret scanning, supply-chain scanning, dependency upgrade management

## Core Judgment

Agents can modify the current files in that repository and preserve those modifications as auditable patches. A patch can express a change to those current files, but it cannot express whether past propagation has been undone.

Agents should not treat the following operations as automatic repair capabilities:

- rewriting git history, such as `git rebase`, `git filter-repo`, or `git filter-branch`
- deleting, rewriting, or reordering existing commits / tags / remote refs
- force pushing or any history replacement flow that requires repository administrator coordination
- cleaning data that has already propagated to forks, clones, CI logs, package registries, container registries, caches, deployment environments, or third-party systems

In other words, an agent patch can change "what the repository looks like from now on", but it cannot guarantee "what did or did not happen in the past". Secrets already leaked through history, large files in historical commits, and sensitive data in old artifacts usually require human governance and repository administrator permissions.

## Why Agents Do Not Automatically Repair Git History

History rewriting is not ordinary code repair. It has several distinct properties:

- **Scope extends beyond the workspace**: local workspace changes cannot cover remotes, forks, clones, caches, registries, CI logs, or other external state.
- **It requires organizational coordination**: force pushes, secret rotation, token revocation, fork cleanup, and cache purge usually require permissions, timing, and human confirmation.
- **It can break collaboration semantics**: rewriting commits affects PRs, branches, tags, releases, downstream clones, and audit records.
- **Repair evidence cannot be expressed by a normal patch**: a diff can prove the current file no longer contains a secret, but it cannot prove every historical copy has been cleaned.
- **It can lure agents into unproductive loops**: in rebased local repositories or limited-history workspaces, agents may try many git commands without being able to complete real governance work.

Therefore, git history remediation should be treated as manual administrative action, not as part of automatic agent patching.

## Classification Decision Table

| Issue type | Analysis stage | Repair stage | Verification stage | Delivery expression |
| --- | --- | --- | --- | --- |
| Application-layer vulnerability in current source | Can confirm or reject based on repository evidence | Can modify current source to form a patch | Verify whether the patch covers the in-scope claim in current source | Deliver patch and verification summary |
| Hardcoded secret in current source | Can confirm exposure in the current files | Can remove the current secret, replace samples, or add prevention rules | Verify the current file no longer exposes it and state whether rotation still needs human action | Deliver current-file patch and express rotation / revocation follow-up |
| Secret only in git history | Can report as a history governance issue, but should not present it as an ordinary source defect | Does not rewrite history; at most adds current-file prevention controls | Does not require patch coverage through history rewriting | Express manual follow-up such as history purge, rotation, fork/cache cleanup |
| Repository-local security configuration flaw | Can confirm as a current repository configuration flaw | Can modify configuration or related startup files | Verify whether the patch changes current configuration semantics | Deliver patch |
| Cloud / deployment / OS / network configuration issue | Enters candidacy only when repository-local configuration directly determines it; otherwise mark out of scope | Does not invent external environment changes | Does not treat lack of external governance proof as source patch failure | Express as manual / external action |
| Dependency CVE or supply-chain upgrade | Usually not a default automatic repair target unless the task explicitly asks for dependency upgrade | Does not automatically perform broad dependency or lockfile upgrades | Does not treat unfinished dependency governance as a current patch defect | Mark as out-of-automation-scope or manual follow-up |
| Published artifact / registry / cache leak | Can identify risks supported by current repository evidence | Does not claim a source patch cleans external copies | Distinguishes current-file mitigation from external cleanup gaps | Express external cleanup actions |

## What Agents Can Still Do

If a history-related issue still leaves something fixable in the current repository, agents can make those prevention-focused changes:

- remove secrets, tokens, credentials, or sensitive samples still present in current files
- add `.gitignore`, secret scanning configuration, pre-commit configuration, or generation rules
- change code or configuration to avoid continuing to generate, commit, print, or package sensitive data
- explicitly state the need for manual actions such as secret rotation, token revocation, history purge, cache purge, or fork cleanup
