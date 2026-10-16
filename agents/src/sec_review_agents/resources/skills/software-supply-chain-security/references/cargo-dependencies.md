# Cargo Dependency Sources And Build Scripts

- Distinguish crates.io, alternate registries, git/path dependencies and source replacement. Cargo source replacement assumes replacement content corresponds to the original source; it is not the same as selecting an unrelated private namespace.
- Check the actual registry/source configuration, package identity, lock entry and revision. A registry declaration or `Cargo.lock` alone does not prove which source a build command consumes.
- `build.rs` is compiled and executed before the package build. Trace attacker-controlled crate content to that script and the developer/CI authority available during the build.

Report only a selectable attacker-controlled source or enabled build script with concrete authority. Do not treat every crate with `build.rs` or every alternate registry as malicious.
