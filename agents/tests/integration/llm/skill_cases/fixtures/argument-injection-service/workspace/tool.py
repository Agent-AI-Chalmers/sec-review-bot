import argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("name", nargs="?")
parser.add_argument("--output", default="/srv/reports/result.txt")
args = parser.parse_args()
Path(args.output).write_text("generated report")
