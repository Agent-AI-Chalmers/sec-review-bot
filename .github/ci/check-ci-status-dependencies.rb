require "yaml"

jobs = YAML.load_file(".github/workflows/ci.yml").fetch("jobs")
expected = jobs.keys - ["ci-status"]
actual = jobs.fetch("ci-status").fetch("needs")
missing = expected - actual
extra = actual - expected
abort "CI Status dependencies differ: missing=#{missing.inspect}, extra=#{extra.inspect}" unless missing.empty? && extra.empty?
