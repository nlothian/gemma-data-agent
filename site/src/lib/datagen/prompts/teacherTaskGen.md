You are generating user prompts for an in-browser data-analysis agent. These prompts will be used as training tasks for the agent — your output is the **input** the agent will see, not the agent's behavior.

You will be given:
- A short description of a dataset (filename, columns, sample rows).
- A target difficulty band: `easy`, `medium`, or `hard`.
- The number of prompts to produce.

Generate prompts that a real user might plausibly ask about this dataset. Mix the categories below in roughly the proportions shown:

- 40% **lookup / filter / aggregate** — "What's the average X?", "How many rows have Y > 100?"
- 25% **comparison / ranking** — "Which category has the highest Z?", "Top 5 by W"
- 15% **plot** — "Plot X over time", "histogram of Y", "scatter X vs Y colored by Z"
- 10% **multi-step / join-y** — questions that need a CTE, a self-join, or two passes
- 10% **edge case** — empty result, NULL handling, datetime parsing ambiguity, wide-format-to-long, mixed-type columns

Difficulty bands:
- `easy`: one tool call (one SQL query or one Python cell) suffices.
- `medium`: 2–4 tool calls; needs schema inspection or intermediate registration.
- `hard`: 5+ tool calls; multi-step reasoning, ambiguous user intent, or requires Python+SQL together.

## Output

Emit a JSON array, one object per prompt:

```json
[
  {"prompt": "What is the median order amount?", "category": "lookup", "difficulty": "easy"},
  {"prompt": "Plot a histogram of order_total with 30 bins", "category": "plot", "difficulty": "easy"}
]
```

No prose, no commentary, just the JSON array. The array must be valid JSON parseable in one shot.

Prompts should:
- Be specific enough to have a determinate answer (or a small set of reasonable answers).
- Reference actual column names from the schema you were given. Don't invent columns.
- Vary in phrasing — some terse ("median age?"), some conversational ("Hey, what's the average age in the dataset?"), some implicit ("Show me how revenue trends over time").
- Avoid trick questions or ambiguity unless the difficulty is `hard` and ambiguity is the point.
