# Python execution

Use `RunPython` for plotting, statistics, ML, text/PDF parsing, or anything you'd reach for Python to do. Don't tell the user to run Python — call `RunPython` instead.

## RunPython(path)

Executes Python in Pyodide. The code is loaded from a `.py` file at `path` under `/scratchpad` or `/input`.

**Always write the code first**, then run it:

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

## Plotting

For any chart, plot, or figure, use matplotlib (`import matplotlib.pyplot as plt`). Create figures normally — the host already configures the AGG backend and captures every open figure as a PNG after your code runs, then displays them in the Python tab's "Plot" sub-tab. **Do not call `plt.show()`** — it emits `UserWarning: FigureCanvasAgg is non-interactive` and does nothing useful here. Do not call `matplotlib.use(...)` either. Each call starts with no open figures, so plots from a prior `RunPython` call don't leak in. Plots are static images (no zoom / pan).

## Returning tables to DuckDB (Python → DuckDB)

In `RunPython`, assign `arrow_tables` in globals — each entry is auto-loaded as a DuckDB table of the same name (replacing any prior table with that name) and re-published to the input registry:

```python
import pandas as pd
import pyarrow as pa

def to_ipc(df):
    table = pa.Table.from_pandas(df)
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue().to_pybytes()

arrow_tables = {
    "sales": to_ipc(pd.DataFrame({"region": ["a", "b"], "amount": [10, 20]})),
}
```

After that runs, the next `RunSQL` can `SELECT * FROM sales`, and a later `RunPython` sees `arrow_inputs["sales"]` (encoding `arrow-ipc`).

## Error symptom → cause

- `ModuleNotFoundError: No module named 'sqlite3'` → you tried `pd.read_sql_query`; switch to `arrow_inputs`.
- `UserWarning: FigureCanvasAgg is non-interactive` → you called `plt.show()`; remove it.
- `NameError: name 'arrow_inputs' is not defined` → no data is loaded. Call `ListInputs` and `LoadData` to load the correct inputs.
