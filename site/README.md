# Gemma Data Agent

An offline data and coding agent with built-in explainability, built for the Kaggle Gemma 4 Good Hackathon.

You can try it yourself at the live [Gemma Data Agent](https://gemma-data-agent.nicklothian.com/) website. It starts with an optional guided tour which will take about 5 minutes and shows all the features. 

Chrome only for now as it requires a WebGPU buffer bigger than 2.5Gb (Firefox only has 1 GB)


## Features

- **Chat with a local Gemma 4 model.** Pick `Gemma 4 E2B` or `E4B` (or load a custom `.task`), watch it stream tokens with WebGPU acceleration.
- **Run code in-browser.** Pyodide for Python, DuckDB-WASM for SQL, and an isolated React sandbox for JSX visualizations (three.js, D3 or ReCharts). The model issues tool calls; the user sees the call, the streamed source, and the result.
- **Ask "how does this app work?".** The Explainer Panel uses Gemma to search over the bundled source code, explains how it works and provides clickable links to view the bundled source.
- **Detailed, step by step explanations.** Use the step mode and the agent will pause before each step, and use a separate Gemma thread to explain what the Agent is about to do.
- **Careful context management**. The smaller Gemma models perform worse as the context length increases. The Agent tracks token counts and runs a compaction when required. Sub-agents further protect the main context from lengthy debugging loops, while progressive disclosure via skills means tool instructions are only added to the context when needed.
