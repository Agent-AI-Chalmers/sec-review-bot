require "yaml"

setup = YAML.safe_load_file(".sec-review/setup.yml").fetch("setup")
actual = setup.filter_map do |step|
  step["working-directory"] if step["run"] == "pnpm install --frozen-lockfile"
end.sort
expected = IO.popen(["git", "ls-files", "*/pnpm-lock.yaml"], &:read).lines.map {
  File.dirname(_1.strip)
}.sort
message = "setup pnpm directories differ:\nexpected=" + expected.inspect + "\nactual=" + actual.inspect
abort message unless actual == expected
