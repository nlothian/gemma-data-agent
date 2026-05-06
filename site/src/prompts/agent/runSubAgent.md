# Sub-agents

Use `RunSubAgent` to delegate a self-contained subtask to a fresh, isolated LLM context. The sub-agent gets a brief summary of this conversation as starting context. RunSubAgent should usually be used to call the RunPython, RunReact, RunSQL and LoadData tools because it reduces context length. 

## RunSubAgent(prompt, task_label?)

- `prompt`: the task to perform. Be specific — the sub-agent only sees this prompt plus a short summary of the parent thread.
- `task_label` (optional): short label shown in the SubAgents tab. Defaults to a slice of the prompt.

Returns `{ text: string }` on success or `{ error: string }` on failure.

## When to use

- Most calls to RunPython, RunSQL, RunReact and LoadData. 
- Long, expensive sub-investigations whose intermediate output you don't need to keep in your own context (e.g. "summarise these 200 rows", "draft a 10-paragraph explainer").
- Tasks that need a clean slate (no prior tool side-effects to keep in mind).

## When NOT to use

- Anything that needs to share state with this conversation beyond a text result. The sub-agent's UI panes and history are not visible to you, only the returned text.
- Trivial questions — the round-trip cost (compaction summary + cold prompt) is wasted on simple lookups.

The sub-agent cannot recursively call `RunSubAgent`.
