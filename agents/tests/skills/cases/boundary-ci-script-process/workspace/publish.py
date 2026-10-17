import subprocess
import sys

subprocess.run(["pkg-publish", sys.argv[1]], check=True)
