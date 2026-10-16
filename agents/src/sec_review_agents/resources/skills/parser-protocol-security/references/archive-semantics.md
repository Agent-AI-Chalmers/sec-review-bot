# Archive Structure And Extraction Semantics

- Treat member names, link targets, entry types, permissions, duplicate normalized names and extraction order as archive-controlled structure.
- Parser policy decides which entries and metadata are accepted; filesystem authority decides where the resulting operation lands. Verify both without duplicating OS path rules here.
- Extraction filters are library/version-specific and may not cover resource exhaustion, pre-existing links, concurrent destination changes or partial extraction cleanup.
- Member count, expanded size and nesting become security relevant when attacker-controlled archives can exceed a concrete resource budget; capacity and admission effects belong to concurrency/resource analysis.

An archive API or compressed file is only a lead. Report the enabled archive feature and concrete filesystem, execution or resource effect.
