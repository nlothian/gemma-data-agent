# File tools

Two virtual roots are available:

- `/input` — the user's sandbox directory. Read-only. Source material.
- `/scratchpad` — your scratch space (OPFS, private to this browser tab). Read/write. Use this for code you intend to execute with `RunPython`/`RunSQL`/`RunReact`.

The workflow is **WriteLines → RunX**. Write code to `/scratchpad/<name>.{py,sql,tsx}` first, then call the execution tool with the same path. On error the result includes `path` so you can `ReadLines` to inspect, `WriteLines` to fix, and re-run.

## ListFiles(path)

Recursively list text files and subdirectories under a virtual path.

- `→ ListFiles({"path":"/input"})` — list the sandbox dir.
- `→ ListFiles({"path":"/scratchpad"})` — list your scratch space.

Returns one absolute virtual path per line; directories end with a trailing `/`. `/input` only shows supported sandbox extensions (csv, xls, xlsx, json, pdf, md, txt, docx, py, sql). `/scratchpad` shows a broader text-file set (also includes ts, tsx, html, yaml, etc.).

`ListFiles` is complementary to `ListInputs`: `ListInputs` shows the in-memory DuckDB / arrow_inputs registry; `ListFiles` shows files on disk.

## ReadLines(path, from, to)

Read lines `[from..to]` (1-indexed, inclusive) from a text file. Output is line-numbered with a header line. Bounds are clamped to the file length.

- `→ ReadLines({"path":"/input/notes.md","from":1,"to":100})` — first 100 lines.
- `→ ReadLines({"path":"/scratchpad/foo.py","from":42,"to":60})` — re-read a snippet you're editing.

Use this before `WriteLines` if you need to confirm current contents, and after a `RunPython`/`RunSQL`/`RunReact` error to read the file at the `path` it returned.

## WriteLines(path, content) — write whole file / WriteLines(path, from, to, content) — edit

Two modes, distinguished by whether `from`/`to` are present:

- **Write the whole file:** omit `from` and `to`; pass just `path` and `content`. Creates the file if absent, or overwrites it wholesale if it already exists.
- **Edit an existing file:** pass `from` and `to` to replace lines `[from..to]` (1-indexed, inclusive) with `content`.
  - **Insert without replacing:** `to=from-1`. The range is empty, content is inserted before line `from`.
  - **Replace lines:** `from=1, to=10` replaces lines 1-10 with `content`.

`/input` is read-only — writes there return an error. Parent directories under `/scratchpad` are auto-created.

Example — create then patch:

```
→ WriteLines({"path":"/scratchpad/foo.py","content":"x = 1\nprint(x)\n"})
← Created /scratchpad/foo.py — 2 lines total.
→ WriteLines({"path":"/scratchpad/foo.py","from":1,"to":1,"content":"x = 2"})
← Updated /scratchpad/foo.py — 2 lines total.
```

`content` is a single JSON string; embed newlines as `\n`.
