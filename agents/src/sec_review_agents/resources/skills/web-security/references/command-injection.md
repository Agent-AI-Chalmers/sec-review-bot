# Command Injection Reference

Use this reference for operating system command execution, shell wrappers, converters, archive tools, media tools, source-control commands, package managers, and child processes influenced by attacker input.

## Sources

- Filenames, paths, URLs, branch names, package names, archive entries, template names, media metadata, user options, flags, environment variables, and config values controlled by users, tenants, external services, or repositories.
- Stored user input later used by workers, build jobs, import/export jobs, CI tasks, or admin utilities.
- Repository content processed by privileged services, such as project names, scripts, manifests, hooks, and generated files.

## Sinks

- Shell execution APIs, `system`, `exec`, `popen`, `shell=True`, `child_process.exec`, backticks, PowerShell/cmd.exe, make/npm/pip/git/docker/kubectl/ffmpeg/ImageMagick wrappers, and template-built command strings.
- Process execution with argument arrays when attacker-controlled values can select the executable, dangerous flags, config files, environment variables, working directory, or plugin/script execution.
- Command output used for security decisions or written to sensitive files.

## Guards

- Prefer APIs that execute a fixed binary with a fixed argument vector and no shell interpreter.
- Treat executable path, subcommand, flags, config files, working directory, environment, and input files as security-relevant, not only shell metacharacters.
- Use strict allowlists for externally selected tools, modes, flags, and filenames.
- Quote/escape only as a last resort and only with library routines for the exact shell/platform.
- Isolate risky converters/build tools and avoid passing secrets to jobs that process attacker-controlled content.

## Report Conditions

Report only when repository evidence shows:

- attacker-controlled data influences a command, executable, argument with command semantics, environment, config, or working directory;
- the command is reachable in a server, worker, CI, or privileged local path;
- validation does not constrain the value to safe constants for that sink;
- impact includes arbitrary command execution, file read/write, code execution through plugin/script behavior, secret exposure, or privileged action.

## False-Positive Precedents

- Argument-array process execution is not automatically vulnerable; inspect whether attacker input can become the executable, dangerous flag, config path, or script selector.
- Shell metacharacter absence is not enough if input controls flags such as output path, config loading, template execution, or remote include behavior.
- Test-only helper commands are not findings unless reachable in production or privileged automation.
- A command name in code is not a finding without attacker influence and reachable execution.
- Escaping may reduce risk for one shell but is fragile across platforms; still require a concrete bypass before confirming.
