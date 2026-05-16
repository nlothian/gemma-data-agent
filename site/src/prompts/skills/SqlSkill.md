---
name: sql
requires-feature: runSql
required: true
when: "your first `RunSQL` call"
blurb: "the WriteLines+RunSQL workflow, the `_last_sql_result` / `arrow_inputs` bridge, sample-row truncation, and `register_as` semantics"
---
# RunSQL reference card

Required reading before invoking `RunSQL`. Fetched on demand via `CallSkill('sql')`.

## RunSQL(path, register_as?)

Executes SQL against an in-browser DuckDB-WASM database. The query is loaded from a `.sql` file at `path` under `/scratchpad` or `/input`.

Use files are `/input`. Call `ListInputs` to find them and prefix file paths with `/input`, so a reference to `train.csv` is for a file path `/input/train.csv`. Call  `ListInputs` to check. 

**Always write the query first**, then run it:

```
→ WriteLines({"path":"/scratchpad/by_region.sql","from":1,"to":0,"content":"SELECT region, SUM(amount) FROM sales GROUP BY region;\n"})
← Created /scratchpad/by_region.sql — 1 lines total.
→ RunSQL({"path":"/scratchpad/by_region.sql"})
```

- On success: `{ columns: [{name, type}], sample_rows: unknown[][], total_rows: number, registered_as: string, path: string }`.
- On failure: `{ error: string, path: string }`. To self-correct, `ReadLines(path, …)` to re-inspect the query, then `WriteLines(path, …)` to fix.
- **You only see 3 sample rows.** The user's UI panel shows up to 1000 rows; you don't. Use `total_rows` to decide whether `sample_rows` is enough, and switch to aggregations or Python for anything that needs the full result.
- **The full Arrow result is always at `arrow_inputs[registered_as]`** — `registered_as` is always `"_last_sql_result"`. To work with all rows in Python, read `pa.ipc.open_stream(arrow_inputs["_last_sql_result"]).read_all()`. It is overwritten on the next `RunSQL` call.
- Long string cells in `sample_rows` are truncated with a `[truncated, full=N chars]` suffix so the schema stays readable. To see a full cell, query that row in Python from `_last_sql_result`.
- DuckDB state persists for the whole chat session — tables you create stay queryable on later calls.
- `register_as: "<name>"` publishes the result under an additional name that **survives subsequent `RunSQL` calls** (which only overwrite `_last_sql_result`). Use this when you need the result later in the conversation. Tables created by `LoadData` are already auto-published under their table name.

## Querying loaded tables

Every `LoadData` of a tabular file (csv / json / parquet / xlsx) creates a DuckDB table named `table_name`, queryable directly:

```sql
SELECT * FROM foo
```

Both `LoadData` tables and `arrow_tables` returned from `RunPython` (see `CallSkill('python-pass-data')`) are auto-published under their name and persist for the whole chat session, so later `RunSQL` calls can join across them. Use `CallSkill('data-loading')` for the load workflow itself.

- Use standard DuckDB SQL syntax.
- **ALWAYS quote column names** — e.g. `"PM10 BAM ug/m3"`; unquoted names with spaces or symbols fail to parse.

## Error symptom → cause

- `"exception_type":"Parser","exception_message":"syntax error at or near` → quote the column names in the query.
- `IO Error: No files found that match the pattern "train.csv"` → try `FROM "/input/train.csv" instead.
