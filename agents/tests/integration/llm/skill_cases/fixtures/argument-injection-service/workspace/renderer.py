import subprocess
import sys
from pathlib import Path


def render(name):
    tool = str(Path(__file__).with_name("tool.py"))
    subprocess.run([sys.executable, tool, name], check=True)
