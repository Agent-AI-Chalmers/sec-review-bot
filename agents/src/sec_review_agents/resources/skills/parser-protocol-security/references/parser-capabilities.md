# Parser Capabilities

- Separate external-resource resolution, entity expansion, schema/include processing and object construction; they have different preconditions and impacts.
- Verify the actual parser library, version, configuration and input path. Defaults can change and must be checked against repository dependencies.
- Connect the enabled capability to attacker-controlled content and a concrete file, network, execution or resource effect.

XML, YAML, JSON, archive or media names are investigation entry points, not vulnerability labels. Safe parsing in one mode does not establish safety or danger in another.
