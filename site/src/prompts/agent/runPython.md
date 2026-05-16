# Python execution

Use `RunPython` for plotting, statistics, ML, text/PDF parsing, or anything you'd reach for Python to do. Don't tell the user to run Python — call `RunPython` instead.

## RunPython(path)

Executes Python in Pyodide. The code is loaded from a `.py` file at `path` under `/scratchpad` or `/input`.

**Always write the code first using WriteLines**, then run it:

```
→ WriteLines({"path":"/scratchpad/analysis.py","from":1,"to":0,"content":"import pandas as pd\nprint(1 + 1)\n"})
← Created /scratchpad/analysis.py — 2 lines total.
→ RunPython({"path":"/scratchpad/analysis.py"})
← { "result": "", "stdout": "2\n", "stderr": "", "path": "/scratchpad/analysis.py" }
```

- On success: `{ result, stdout, stderr, path }` where `result` is the str() of the last expression.
- On failure: `{ error, stdout, stderr, path }`. To self-correct, `ReadLines(path, …)` to re-inspect the file, then `WriteLines(path, …)` to fix, then re-run.
- `loadPackagesFromImports` runs first, so `import pandas as pd` and `import pyarrow as pa` work out of the box (first import is slow).

Read tabular data from `arrow_inputs[name]` (Arrow IPC bytes — decode with `pa.ipc.open_stream(arrow_inputs[name]).read_all()`). Read non-tabular data from `arrow_inputs[name]` as raw bytes and decode per format (`TextDecoder`, `pypdf`, etc.).

## Forbidden in RunPython

`RunPython` runs in a separate Pyodide Worker with **no DuckDB driver and no sqlite3 module**. The only way to read table data in Python is `arrow_inputs[name]`.

- `pd.read_sql_query` / `pd.read_sql` → fails with `ModuleNotFoundError: No module named 'sqlite3'`.
- `import duckdb` / `duckdb.connect` → no driver in the worker.
- `import sqlite3` / SQLAlchemy → same.

If you need a query result in Python, either the table was already loaded by `LoadData` (read `arrow_inputs["<table>"]`) or call `RunSQL` first (with `register_as="<name>"`) and then read `arrow_inputs["<name>"]`.

If the user asks for SQL, then call `RunSQL`.

## Plotting

For any chart, plot, or figure, **call `CallSkill('matplotlib')` BEFORE writing matplotlib code** — the host has specific figure-capture behaviour and a `plt.show()` pitfall you need to know.

## Returning tables to DuckDB

To send tables from Python back into DuckDB, assign to a global named `arrow_tables`. **Call `CallSkill('python-pass-data')` BEFORE writing that assignment** — it shows the required Arrow IPC encoding (a plain DataFrame won't work).

## Error symptom → cause

- `ModuleNotFoundError: No module named 'sqlite3'` → you tried `pd.read_sql_query`; switch to `arrow_inputs`.
- `UserWarning: FigureCanvasAgg is non-interactive` → you called `plt.show()`; remove it.
- `NameError: name 'arrow_inputs' is not defined` → no data is loaded. Call `ListInputs` and `LoadData` to load the correct inputs.
