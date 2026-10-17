# Joern

The sandbox provides `joern` and `joern-parse` for code property graph analysis. Use bash to invoke them, and inspect `joern --help` or `joern-parse --help` when you need to discover their interfaces. For a non-interactive query, first create a CPG with `joern-parse --language <language> /workspace -o /tmp/cpg.bin`, then pipe separate lines containing `importCpg("/tmp/cpg.bin")` and the query into `joern` from a writable directory such as `/tmp`. Do not use `joern --script /dev/stdin`; Joern treats scripts as files and that stdin form may not terminate.
