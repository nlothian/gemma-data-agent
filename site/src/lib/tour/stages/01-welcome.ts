import type { TourStage } from '../types';

const welcome: TourStage = {
  id: 'welcome',
  markdown: `# How Agents Work

This app uses Gemma 4 to demonstrate how AI agents work, end to end.

It is a fully functional, fully private agent environment running entirely in your browser, so feel free to experiment.

Key features:
- **Tool use** — run Python (via Pyodide), SQL (via DuckDB), and React, all in the browser.
- **Data loading** — load CSV or Parquet files from a sandboxed local folder (via the HTML5 File System Access API) or from remote servers (via DuckDB).
- **Context management** — local models have a smaller context window, so the app manages it carefully using sub-agents and compaction.
- **Self-explaining code** — the app ships with its own source code, so the built-in AI explainer can show you how any part of it works.

This tour walks through these features and takes about 5 minutes, depending on your hardware.
`,
  cutouts: [],
  onEnter: [{ action: 'newChat' }],
  next: 'manual',
};

export default welcome;
