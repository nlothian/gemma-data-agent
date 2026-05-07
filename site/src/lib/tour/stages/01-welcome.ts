import type { TourStage } from '../types';

const welcome: TourStage = {
  id: 'welcome',
  markdown: `# How Agents Work

This app uses Gemma4 to show how agents work. It is a fully functional
private agent envionment, so you are encouraged to play with it.

Some features include:
- Tool use: we can run Python (thanks to Pyodide), SQL (DuckDB) and React all inside your browser.
- 
`,
  cutouts: [],
  onEnter: [{ action: 'newChat' }],
  next: 'manual',
};

export default welcome;
