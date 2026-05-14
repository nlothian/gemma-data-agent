# SQL queries

Use `RunSQL` for filtering, aggregating, joining, or any analysis you can express in SQL. Don't tell the user to run a SQL query — call `RunSQL` instead.

You **MUST** call `CallSkill('sql')` BEFORE your first `RunSQL` call. It documents the required `WriteLines` + `RunSQL(path)` workflow, the `_last_sql_result` / `arrow_inputs[...]` bridge, the `register_as` semantics, sample-row truncation, and the DuckDB error idioms.
