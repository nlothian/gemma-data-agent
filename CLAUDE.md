# Project notes

## No SSR

This project does not use SSR. Astro is configured for static output and the
app runs entirely in the browser. Treat all React components as client-only:

- Use `client:only="react"` for React islands rather than `client:idle` /
  `client:load` / `client:visible` — there is no value in producing server
  HTML for them, and SSR-only warnings (e.g. `useLayoutEffect does nothing on
  the server`) should be fixed by skipping SSR, not by working around it.
- Browser-only APIs (`window`, `document`, `localStorage`, etc.) can be used
  directly inside React components without `typeof window` guards.

## Loading the local Gemma model for testing

The repo's `models/` directory is gitignored and may contain a local
`.task` file (e.g. `gemma-4-E4B-it-web.task`) you can load instead of
downloading one of the predefined Gemma weights from CDN. This is the
fastest way to exercise an end-to-end LLM run from a fresh browser
session.

To load it in Chrome (manual or via chrome-devtools MCP):

1. `cd site && pnpm dev` — Astro picks the next free port; check the
   "Local" line in stdout for the URL (typically `http://localhost:4321`
   or `:4322`).
2. Open the page and click the chevron next to **Choose model** in the
   chat sidebar to open the model menu.
3. Click **Advanced** → **Choose .task file…** and pick
   `models/gemma-4-E4B-it-web.task` from the repo root. The file is
   read directly from disk via `File.stream()` and skips the OPFS cache
   entirely (`site/src/lib/localLlm/customModels.ts`).
4. Wait for the "Loading … · 100%" status to disappear; the chat
   textarea becomes enabled when the model is ready.

Custom-model registrations live in memory only — the file picker has to
be used again after every page reload. Predefined Gemma URLs are cached
in OPFS, so subsequent loads of those are near-instant.

To exercise a specific tour stage without walking the whole flow, start
a one-stage tour via the controller in DevTools:

```js
const c = await import('/src/lib/tour/controller.ts');
const s = await import('/src/lib/tour/stages/index.ts');
const stage = s.DEFAULT_TOUR.stages.find((x) => x.id === '<stage-id>');
c.startTour({ id: 'jump', stages: [stage] });
```
