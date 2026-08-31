# SQL Injection Reference

Use this reference for SQL query construction, raw ORM fragments, dynamic filters, dynamic sorting, report builders, search endpoints, and stored data later used in queries.

## Sources

- Route/query/body parameters, GraphQL variables, RPC inputs, search strings, filters, sort keys, column names, table names, tenant IDs, pagination, and report/export parameters.
- Stored user input later concatenated into a query, including names, slugs, tags, metadata, custom fields, formulas, and admin-configured templates.
- Request-derived values passed through helper functions that return SQL fragments or ORM raw expressions.

## Sinks

- Raw SQL execution APIs, string-built query builders, template literals, interpolation, `whereRaw`, `orderByRaw`, `literal`, `text`, `exec`, stored procedure calls, and dynamic schema/table/column names.
- ORM escape hatches, migration/admin consoles, report builders, analytics queries, full-text search, and custom filter DSLs.
- Second-order query construction where data previously stored safely is later treated as trusted SQL syntax.

## Guards

- Use parameterized queries or prepared statements for values.
- For identifiers such as table/column/order direction, use strict allowlists that map external names to internal constants.
- Keep query structure separate from untrusted values; do not rely on escaping when structural SQL syntax is attacker-controlled.
- Verify ORM helpers actually parameterize the specific API call; raw fragments often bypass ORM protection.
- Apply tenant/authorization constraints independently of user-controlled filters.

## Report Conditions

Report only when repository evidence shows:

- attacker-controlled data reaches SQL structure or value context unsafely;
- the query sink executes against a real database path;
- guard coverage is missing or insufficient for the specific context;
- impact includes data disclosure, mutation, auth bypass, tenant bypass, destructive query, or privileged DB behavior.

## False-Positive Precedents

- Parameterized queries are not vulnerable merely because they include user input.
- Dynamic filter/sort is not a confirmed issue if external values are mapped through a finite server-side allowlist.
- ORM use is not automatically safe; raw fragments still need inspection.
- Escaping may be adequate for simple values in some libraries, but it is not a guard for identifiers or SQL keywords.
- A string containing SQL-like text in tests, docs, migrations, or static constants is not a finding without attacker influence.
