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

## Globals (no imports, no third-party libs)

`React` is a global, and so are the common hooks: `useState`, `useEffect`, `useRef`, `useMemo`, `useCallback`, `useReducer`, `useContext`. **Do not write `import` statements** — there is no module loader in the sandbox; imports compile through but throw at runtime. Only React 18 + the DOM + standard browser APIs are available; libraries like `recharts`, `lodash`, etc. are not.

## Sandbox

The iframe is `sandbox="allow-scripts"` with a `null` origin. It cannot read host cookies, `localStorage`, the parent DOM, or other tabs. `fetch` works but cross-origin reads need CORS.

## Error symptom → cause

- `App is not defined` → snippet didn't define an `App` component; rename your top-level component to `App`.
- `Cannot use import statement outside a module` / `require is not defined` → strip `import` / `require` lines; use the `React` and hook globals directly.
- `Invalid hook call` / `Hooks can only be called inside the body of a function component` → you called a hook outside `App` or in a regular helper; move it inside the component.
