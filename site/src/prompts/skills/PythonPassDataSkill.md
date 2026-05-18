---
name: python-pass-data
requires-feature: runPython
required: false
when: "reading `arrow_inputs` or returning tables via `arrow_tables` in `RunPython`"
blurb: "decoding registry buffers from `arrow_inputs` and the Arrow IPC encoding for returning tables via `arrow_tables`"
---
# Using data in RunPython (read `arrow_inputs`, return `arrow_tables`)

Reference card for the two-way data bridge in `RunPython`: reading loaded inputs out of `arrow_inputs`, and sending results back into DuckDB via `arrow_tables`. Fetched on demand via `CallSkill('python-pass-data')`.

## Reading inputs (`arrow_inputs`)

Every loaded registry entry is exposed in `RunPython` as `arrow_inputs[name]`. Decode it according to its `encoding` (from `ListInputs` — see `CallSkill('data-loading')`):

- `arrow-ipc` — an Arrow IPC stream (csv/json/parquet/xlsx tables, `sql-result`, `python-result`):

```python
import pyarrow as pa, pandas as pd, matplotlib.pyplot as plt
df = pa.ipc.open_stream(arrow_inputs["foo"]).read_all().to_pandas()
df["t"] = pd.to_datetime(df["Date/Time"])  # CSV time columns load as strings — parse them
plt.plot(df["t"], df["PM10 BAM ug/m3"])
plt.xlabel("time"); plt.ylabel("PM10 µg/m³")
```

  Reading is **`pa.ipc.open_stream(...).read_all()`** — there is no `pa.ipc.read_table` (that's `pyarrow.parquet.read_table`, a different module). Note the read/write asymmetry: you write with `pa.ipc.new_stream(...)` + `writer.write_table(...)` (see below), but you read back with `open_stream(...).read_all()`, not a matching `read_table`.

- `raw-bytes` — the file's raw bytes (non-tabular sandbox files: md, txt, py, sql, pdf, docx). Decode per `format`:

```python
text = arrow_inputs["readme"].decode("utf-8")        # md / txt / py / sql
import io, pypdf
pdf = pypdf.PdfReader(io.BytesIO(arrow_inputs["doc"]))   # pdf
```

The full result of the most recent `RunSQL` call is always at `arrow_inputs["_last_sql_result"]` (encoding `arrow-ipc`) — read it the same way. See `CallSkill('sql')` for its lifetime and `register_as`.

## Returning tables (`arrow_tables`)

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

You **MUST** still call `WriteLines` to write code before calling RunPython.
