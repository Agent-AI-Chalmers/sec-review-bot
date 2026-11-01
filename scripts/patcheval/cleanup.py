"""Remove only containers belonging to one interrupted/completed experiment attempt."""

import argparse
import subprocess

from sec_review_agents.filesystem.docker_runtime import default_docker_bin
from sec_review_agents.utils.env import bootstrap_agents_env


def cleanup(label: str) -> None:
    docker = default_docker_bin()
    result = subprocess.run(
        [docker, "ps", "-aq", "--filter", f"label=sec-review.run={label}"],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    containers = result.stdout.split()
    if containers:
        subprocess.run([docker, "rm", "-f", *containers], check=True, timeout=60)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    bootstrap_agents_env()
    cleanup(args.label)


if __name__ == "__main__":
    main()
