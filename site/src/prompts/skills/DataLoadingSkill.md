---
name: data-loading
requires-feature: dataLoading
required: true
when: "invoking `LoadData` or `ListInputs`"
blurb: "the read/load workflow, input-registry shape, sandbox path conventions, and CORS error handling"
---
# LoadData / ListInputs reference card

Required reading before invoking `LoadData` or `ListInputs`. Fetched on demand via `CallSkill('data-loading')`.

This card covers *getting data in*. Once a file is loaded it is both a DuckDB table and an `arrow_inputs` registry buffer — to query it in SQL see `CallSkill('sql')`, to read or decode it in `RunPython` see `CallSkill('python-pass-data')`.

## Read / load workflow

Whenever the user names a file, table, dataset, or "the X data" — even if you think you've seen it before — start with `ListInputs`. It returns both already-loaded entries and supported sandbox files that are still on disk. Then:

1. Find the entry whose `name` or `sourcePath` matches what the user asked for. Match leniently (filename, basename without extension, table name).
2. If the matching entry has `loaded: true`, it's already in `arrow_inputs[name]` — go straight to using it.
3. If the matching entry has `loaded: false`, call `LoadData(url=sourcePath, table_name=…)` first, then proceed. Pass `sourcePath` verbatim — it is already `/input/…`-rooted; do not strip it or add a `sandbox:` / `file://` prefix. Pick a `table_name` matching `[A-Za-z_][A-Za-z0-9_]*` (typically the filename's stem).
4. If nothing matches, tell the user what you do see — don't guess a path or fabricate a `LoadData` call against a name that wasn't in `ListInputs`.

Skip the `ListInputs` round-trip only when the user's last message in this same turn already gave you a fully-qualified URL (`https://…`).

## The input registry

There is a single named-buffer registry that is the only bridge between data-loading, SQL, and Python. Every entry has:

- `name` — the key, e.g. `"sales"`.
- `encoding` — either `"arrow-ipc"` (an Arrow IPC stream) or `"raw-bytes"` (the file's raw bytes). How to decode each inside `RunPython` is in `CallSkill('python-pass-data')`.
- `format` — describes the original data: `csv`, `json`, `parquet`, `xlsx`, `md`, `txt`, `py`, `sql`, `pdf`, `docx`, `sql-result`, or `python-result`.
- `source` — `"url"`, `"sandbox"`, `"sql"`, or `"python"`.
- `schema` / `rowCount` — present for `arrow-ipc` entries.

Use `ListInputs` whenever you need to recover the current state.

## LoadData(url, table_name, format?)

Load a tabular or non-tabular data file. The first argument is either a remote URL (contains `://`) or a path inside the user's sandbox directory.

For sandbox files, pass the `sourcePath` from `ListInputs` **verbatim** — never construct a path yourself. It is `/input/...`-rooted (e.g. `/input/reports/sales.csv`), the same form `ListFiles`/`ReadLines` use. For forgiveness the `/input` prefix, a `sandbox:` / `file://` scheme, and a leading `./` are auto-stripped, and a bare `reports/sales.csv` also resolves — but the only instruction that always works is *pass `sourcePath` as-is*. A path with `.` or `..` segments (`../x`, `a/../b`, `foo/./bar`) is **rejected** with an error telling you to re-issue using the exact `ListInputs` `sourcePath`; don't try to repair it by hand.

**Tabular files** (csv, json, parquet, xlsx) are loaded as a DuckDB table named `table_name` AND auto-published to the input registry as Arrow IPC under the same name. It is then queryable in SQL as `table_name` and readable in `RunPython` via `arrow_inputs["table_name"]` — see `CallSkill('sql')` / `CallSkill('python-pass-data')` for how.

- On success: `{ name, url, format, schema: [{name, type}], rowCount }`.
- `table_name` must match `[A-Za-z_][A-Za-z0-9_]*`.
- xlsx loads use the first sheet only.

**Non-tabular sandbox files** (md, txt, py, sql, pdf, docx) are registered as `raw-bytes` under `table_name`. No DuckDB table is created — read and decode them inside `RunPython`; the per-format recipes are in `CallSkill('python-pass-data')`.

- On success: `{ name, path, format, sizeBytes, virtualPath }` (`format` is `"text"`, `"binary"`, or `"xlsx"`).

**Failures** return `{ error: string }`. Format is inferred from the extension; pass `format: "csv" | "json" | "parquet" | "xlsx"` to override.

**Sandbox availability:** if no sandbox directory has been chosen, local-path loads fail with a message asking the user to pick one in Settings. If permission was lost (page reload, revoked), the tool surfaces a "re-authorise" error — pass that on to the user.

**CORS (remote only):** the file is fetched in the browser, so the server must send `Access-Control-Allow-Origin`. If it does not, the tool returns an error containing "Access-Control-Allow-Origin" — quote that error to the user verbatim and suggest a CORS-enabled host (e.g. `raw.githubusercontent.com`, an S3 bucket with CORS configured, or `https://shell.duckdb.org/data/...`). Do not retry the same URL.

Prefer `LoadData` over fetching files inside other tools.

## Error symptom → cause

- `Access-Control-Allow-Origin` in a `LoadData` error → CORS blocked; quote the error and suggest a CORS-enabled host. Do not retry the same URL.

## ListInputs()

Returns `{ inputs: Array<entry> }`. Each entry is one of two shapes distinguished by `loaded`:

- **Loaded** (`loaded: true`) — already in the registry, available immediately as `arrow_inputs[name]`: `{ loaded: true, name, encoding, format, source, sourcePath?, schema?, rowCount?, byteLength, publishedAt }`. Use the `encoding` field to decide how to decode it (`CallSkill('python-pass-data')` covers `arrow-ipc` vs `raw-bytes`).
- **Unloaded** (`loaded: false`) — a supported file in the user's sandbox directory that has not been loaded yet: `{ loaded: false, source: "sandbox", sourcePath, format, byteLength }`. `sourcePath` is `/input/...`-rooted (e.g. `/input/reports/sales.csv`), matching `ListFiles`/`ReadLines`. To use one, call `LoadData(url=sourcePath, table_name=…)` — pass it verbatim.

Sandbox-sourced **loaded** entries report their `sourcePath` under `/input/...` too; `url`, `sql`, and `python` sources keep their `sourcePath` unchanged.

Read-only and ungated. This is the canonical way to discover what data is available — call it before asking the user "what files do you have?", and to recover state after a page reload (when prior `LoadData` results may be gone, but the sandbox files remain).
