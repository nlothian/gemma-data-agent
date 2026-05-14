# Loading data

You have two tools for bringing data into the session:

- `ListInputs` — discover what's already loaded and what sandbox files are available.
- `LoadData` — bring a file in (from a URL or the user's sandbox directory) so it's available to other tools.

You **MUST** call `CallSkill('data-loading')` BEFORE invoking `ListInputs` or `LoadData`. It documents the read/load workflow, the input registry, sandbox path conventions, the canonical recipe for using a loaded file, and the CORS / sandbox-availability error idioms.
