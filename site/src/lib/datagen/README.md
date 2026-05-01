# haw data generation mode

Developer-only mode for building fine-tuning datasets for the in-browser
Gemma agent. Lives behind `VITE_HAW_DATAGEN=1`; not part of production
builds.

## Why this exists

The agent's failure modes — malformed `<|tool_call>` syntax, hallucinated
column names, DuckDB-vs-SQLite confusion, Pyodide package gaps — are
specific to *this harness*. Generic instruction-tuning data won't fix
them. We need trajectories that exercise the actual production runtime.

This mode runs that runtime against a local task corpus and writes JSONL
that downstream training jobs (LoRA + DPO) can consume.

## Architecture

The data-gen route reuses **every** runtime module from production:

```
parser, tool dispatch, DuckDB, Pyodide ─┐
local-LLM driver (LiteRT/MediaPipe)     │
OpenRouter client                       ├─ unchanged production modules
sandboxStore (input directory)          │
useSandboxConfig hook                   ┘

                    ▲
                    │ imported, not duplicated
                    │
   ┌────────────────┴───────────────────┐
   │   site/src/lib/datagen/            │
   │     outputDir.ts    – FS Access    │
   │                       (output dir) │
   │     teacher.ts      – OR wrapper   │
   │     trajectory.ts   – teacher loop │
   │     studentRollout.ts – LiteRT     │
   │     judge.ts        – grading      │
   │     goldPipeline.ts                │
   │     rejectionPipeline.ts           │
   │     taskGen.ts                     │
   │     probeDataset.ts                │
   │     dpo.ts                         │
   │     prompts/*.md                   │
   └────────────────────────────────────┘
```

Rollouts run via the *exact* MediaPipe LiteRT path that ships, so
rejection-sampling negatives are the mistakes real users see — no
quantization drift, no sampler drift.

## Two directories, two purposes

|                | **Sandbox** (input)                     | **Output directory**                |
|----------------|-----------------------------------------|-------------------------------------|
| Permission     | read-only                               | read-write                          |
| Holds          | input datasets (CSV / Parquet / JSON)   | tasks, trajectories, DPO pairs      |
| Picker         | `useSandboxConfig` from production      | `outputDir.ts` (data-gen only)      |
| Shared with    | the live agent — same `currentHandle`   | data-gen only                       |
| `LoadData`     | resolves relative paths against this    | not used for input                  |

The agent's `LoadData("datasets/iris.csv", "iris")` resolves against the
sandbox via the same `runLoadDataLocal` the live chat uses. No special
prompts, no path bridging.

## Quick start

1. **Run dev with the flag:**
   ```sh
   cd site && VITE_HAW_DATAGEN=1 npm run dev
   ```

2. **Set up an OpenRouter API key** in the main app (`/`). Open Settings,
   pick OpenRouter as a provider, paste your key. The data-gen mode
   reads from the same `apiKeys` storage.

3. **Open `/datagen` in a separate browser tab** from `/`. DuckDB,
   Pyodide, and Gemma are per-tab singletons.

4. **Pick a sandbox.** Put your input datasets here:
   ```
   sandbox/                  ← read-only, picked via the Sandbox card
     datasets/
       iris/Iris.csv
       <more>...
   ```
   This is the same sandbox the live agent uses; picking here updates it
   everywhere.

5. **Pick an output directory.** Generated artefacts land here:
   ```
   output_dir/               ← read-write, picked via the Output card
     tasks/
       normal-<timestamp>.jsonl
       adversarial-<timestamp>.jsonl
     trajectories.jsonl
     dpo.jsonl
   ```
   Both directory handles persist in IndexedDB across reloads.

## The four panels

### 1. Generate task corpus

Asks the teacher (any OpenRouter model) for a batch of `{prompt,
category, difficulty}` entries given a dataset from the sandbox. The
dataset dropdown reads from the sandbox file list (filtered to
csv/tsv/parquet/json/jsonl/xlsx); selecting a file probes its schema
via DuckDB and pre-fills the schema summary.

Two flavors:
- **Normal** — mixed difficulty (lookup, aggregate, plot, multi-step).
- **Adversarial** — targets known weak spots (schema traps, false
  premises, refusal probes).

Output: `<output_dir>/tasks/<flavor>-<timestamp>.jsonl`.

You can also write task corpora by hand. Format:
```jsonl
{"taskId": "iris-001", "prompt": "Plot histogram of sepal_length", "dataset": "datasets/iris.csv", "difficulty": "easy"}
```
Drop the file under `<output_dir>/tasks/`.

### 2. Gold pipeline

For every task in `<output_dir>/tasks/*.jsonl`:
- Resets the input registry (hermetic per trajectory).
- Runs the teacher as the assistant, with each tool call executed against
  the real DuckDB / Pyodide runtime, with `LoadData` resolving against
  the sandbox.
- Appends one `TrajectoryRecord` to `<output_dir>/trajectories.jsonl`.

Resumable: skips taskIds already present with `sourcePipeline=gold`.

### 3. Rejection sampling

For every task with a gold reference:
- Runs **N** student rollouts via the real LiteRT path.
- Scores each one:
  - Automatic signals (parse-OK, no tool errors, finished, hard-error)
  - **Judge** (another OpenRouter call) compares the student's final
    answer to the gold. Tolerant of phrasing/format differences;
    catches confidently-wrong answers.
- De-duplicates rollouts on identical `historyText`.
- Builds DPO pairs as the cross product of distinct successes ×
  distinct failures.
- Appends pairs to `<output_dir>/dpo.jsonl` and every individual rollout
  to `<output_dir>/trajectories.jsonl` (so failures aren't lost).

Resumable: skips taskIds whose rollouts are already in `trajectories.jsonl`.

### 4. Test trajectory (one shot)

Manual diagnostic: type one user prompt, run one teacher trajectory,
inspect turn-by-turn output. Useful for prompt engineering and
verifying the teacher is producing the right shape before launching a
corpus run.

## Output formats

### `trajectories.jsonl`

One JSON object per line:

```json
{
  "schema": "haw-trajectory-v1",
  "runId": "2026-04-30T15:34:01.123Z",
  "taskId": "iris-001",
  "userPrompt": "...",
  "systemPrompt": "...",
  "turns": [
    { "kind": "tool_call", "prose": "Let me check the schema.",
      "toolName": "RunSQL", "args": {"sql": "DESCRIBE iris"}, "result": {...},
      "resultError": null, "durationMs": 412 },
    { "kind": "final", "prose": "The mean sepal length is 5.84.", "durationMs": 0 }
  ],
  "outcome": "completed",
  "outcomeDetail": null,
  "sourcePipeline": "gold",
  "teacherModel": "anthropic/claude-sonnet-4.5",
  "studentModel": null,
  "createdAt": "...",
  "durationMs": 14210
}
```

`sourcePipeline` is one of `gold` / `rejection-chosen` /
`rejection-rejected`. Student rollouts use a `taskId` of `<base>#<index>`.

For training, downstream code extracts `(prompt, completion)` pairs by
replaying turns through `renderConversationForGemma` from
`localLlm/toolPrompt`.

### `dpo.jsonl`

```json
{
  "schema": "haw-dpo-v1",
  "runId": "...",
  "taskId": "iris-001",
  "userPrompt": "...",
  "systemPrompt": "...",
  "chosen": "<production-format string with <|tool_call> tokens>",
  "rejected": "<production-format string with <|tool_call> tokens>",
  "chosenDisplayText": "...",
  "rejectedDisplayText": "...",
  "chosenFinalAnswer": "...",
  "rejectedFinalAnswer": "...",
  "chosenJudgeReasoning": "Both arrived at 5.84.",
  "rejectedFailureReason": "judge_incorrect",
  "studentModel": "gemma-4-e2b",
  "judgeModel": "anthropic/claude-haiku-4.5",
  "createdAt": "..."
}
```

`chosen` and `rejected` are the **training-target format** (with the
actual `<|tool_call>` and `<|tool_response>` LiteRT tokens) — feed
these directly to a DPO trainer.

## Downstream: extracting SFT pairs

`trajectories.jsonl` records contain structured turns plus runtime
context. To produce SFT pairs, replay the turns through Gemma's
chat-template renderer:

```ts
// site/src/lib/localLlm/toolPrompt.ts
import { renderConversationForGemma } from './toolPrompt';
```

A small offline script (Node, importing from `site/src/lib/`) can:
1. Filter `(sourcePipeline === 'gold' && outcome === 'completed') || sourcePipeline === 'rejection-chosen'`.
2. For each trajectory, walk its turns. At each model emission, render
   the conversation up to that point as the *prompt*, and the emitted
   text (with `<|tool_call>` tokens) as the *completion*.
3. Emit one `{prompt, completion}` per turn.

For DPO, `chosen` / `rejected` are already in the wire format; the
extractor just needs the prompt prefix.

## Known limitations

- **Chromium-only.** File System Access API is required.
- **Single tab is sequential.** ~30s per trajectory on E2B → ~17h for a
  2k-trajectory corpus on one tab. Open multiple tabs / windows for
  parallelism (each loads its own Gemma into VRAM; GPU contention
  starts to bite around 2 tabs on a 16GB card).
- **Production bundle.** The `/datagen` route renders a "not enabled"
  stub when `VITE_HAW_DATAGEN` is unset, but the data-gen module code
  may still be reachable via the page's import graph. Treat the flag
  as a *runtime* gate, not a bundle-size guarantee. For a small
  production bundle, delete `pages/datagen.astro` before `astro build`.
- **No automatic SFT pair extraction yet.** Inspection JSONL is
  written; the downstream replay-to-pairs script is left to the
  training pipeline.
