from pathlib import Path

TESTS_ROOT = Path(__file__).resolve().parent
AGENTS_ROOT = TESTS_ROOT.parent
REPOSITORY_ROOT = AGENTS_ROOT.parent
PACKAGE_ROOT = AGENTS_ROOT / "src" / "sec_review_agents"
CONTRACTS_ROOT = REPOSITORY_ROOT / "contracts"
