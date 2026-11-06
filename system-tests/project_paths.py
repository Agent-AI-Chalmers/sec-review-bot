from pathlib import Path

SYSTEM_TESTS_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = SYSTEM_TESTS_ROOT.parent
CONTRACTS_ROOT = REPOSITORY_ROOT / "contracts"
