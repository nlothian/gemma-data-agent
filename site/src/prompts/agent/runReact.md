# React UI

Use `RunReact` to build small interactive UIs — counters, forms, tables, charts, dashboards, anything the user can click. Don't tell the user to write React code — call `RunReact` instead.

## RunReact(code)

Executes a TypeScript + React snippet inside an isolated iframe and renders the component into the React tab's "View" sub-tab.

- On success: `{ ok: true, compileErrors: [], runtimeErrors: [] }`.
- On failure: `{ ok: false, compileErrors: [{message, line?, column?}], runtimeErrors: [{message, stack?}] }`.
- Compile errors come from `typescript` (parse / JSX syntax). Runtime errors are collected for ~750ms after mount via `window.onerror`, `unhandledrejection`, and a top-level error boundary, then returned. If errors come back, **fix the code and call `RunReact` again** — don't ask the user.

## Required shape

The snippet must define a component named `App`. The host renders `<App/>`.

```tsx
function App() {
  const [n, setN] = React.useState(0);
  return <button onClick={() => setN(n + 1)}>clicked {n}</button>;
}
```

## Globals and imports

`React` is a global, and so are the common hooks: `useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`, `useReducer`, `useContext`. You can use those directly, or write the more idiomatic form:

```tsx
import React, { useState } from 'react';
```

Only `"react"` and `"react-dom"` (and `"react-dom/client"`) can be imported — both resolve to the React 18 globals via a CommonJS shim. Any other import (`recharts`, `lodash`, CSS, …) will throw `Module "X" is not available in the React sandbox` at runtime. Only React 18 + the DOM + standard browser APIs are available.

## Sandbox

The iframe is `sandbox="allow-scripts"` with a `null` origin. It cannot read host cookies, `localStorage`, the parent DOM, or other tabs. `fetch` works but cross-origin reads need CORS.

## Environment notes

- **Don't mount the component yourself.** The host calls `ReactDOM.createRoot(...).render(<App/>)`. Do not call `createRoot` / `render` / `hydrateRoot` in the snippet — it'll fight the host's mount.
- **No data or file access.** The iframe can't see DuckDB tables, sandbox files, or anything `LoadData` produced. To display data, inline it as a literal in the snippet (compute the values in `RunPython` / `RunSQL` first and paste them in).
- **Styling is inline or `<style>`.** `style={{...}}` props work directly. For class-based styling, include a `<style>` element inside `App`'s tree. CSS imports are not supported.

## Error symptom → cause

- `App is not defined` → snippet didn't define an `App` component; rename your top-level component to `App`.
- `Module "X" is not available in the React sandbox` → you imported something other than `react`/`react-dom`; remove the import and inline the behaviour or pick a different approach.
- `Invalid hook call` / `Hooks can only be called inside the body of a function component` → you called a hook outside `App` or in a regular helper; move it inside the component.
