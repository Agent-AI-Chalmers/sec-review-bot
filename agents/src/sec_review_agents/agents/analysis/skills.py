# Keep this allowlist in code: it is a small agent-bound contract, not a
# separate operator-tuned configuration surface.
ANALYSIS_AGENT_SKILLS = (
    "cwe",
    "web-security",
    "ci-security",
    "memory-numeric-safety",
    "cryptography-security",
    "concurrency-resource-security",
    "os-boundary-security",
    "parser-protocol-security",
    "software-supply-chain-security",
    "authorization-delegation-security",
)
