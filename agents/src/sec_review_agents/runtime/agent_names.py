REVIEW_AGENT_NAMES = frozenset(
    {
        "repository-discovery",
        "repository-triager",
        "issue-analyzer",
        "pull-request-analyzer",
        "repository-analyzer",
        "issue-mitigator",
        "issue-mitigator-self-check",
        "pull-request-mitigator",
        "repository-mitigator",
        "issue-verifier",
        "pull-request-verifier",
        "repository-verifier",
        "issue-single-agent",
        "repository-cvss-v4-scorer",
        "repository-delivery-planner",
        "patch-synthesizer",
    }
)

MEMORY_AGENT_NAMES = frozenset({"memory-extractor", "memory-maintainer"})

RUNNABLE_AGENT_NAMES = REVIEW_AGENT_NAMES | MEMORY_AGENT_NAMES
