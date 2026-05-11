# React UI

Use `RunReact` to build small interactive UIs — counters, forms, tables, charts, dashboards, anything the user can click. Don't tell the user to write React code — call `RunReact` instead.

## RunReact(path)

Executes a TypeScript + React snippet inside an isolated iframe and renders the component into the React tab's "View" sub-tab. The snippet is loaded from a `.tsx` file at `path` under `/scratchpad` or `/input`.

**Always write the snippet first**, then run it:

```
→ WriteLines({"path":"/scratchpad/counter.tsx","from":1,"to":0,"content":"function App() {\n  const [n, setN] = React.useState(0);\n  return <button onClick={() => setN(n + 1)}>clicked {n}</button>;\n}\n"})
← Created /scratchpad/counter.tsx — 4 lines total.
→ RunReact({"path":"/scratchpad/counter.tsx"})
```

- On success: `{ ok: true, compileErrors: [], runtimeErrors: [], path }`.
- On failure: `{ ok: false, compileErrors: [{message, line?, column?}], runtimeErrors: [{message, stack?}], path }`.
- Compile errors come from `typescript` (parse / JSX syntax). Runtime errors are collected for ~750ms after mount via `window.onerror`, `unhandledrejection`, and a top-level error boundary, then returned. If errors come back, `ReadLines(path)` to re-inspect, `WriteLines(path, …)` to fix, then call `RunReact` again — don't ask the user.

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

### Available libraries

The sandbox pre-loads a curated set of graphics, animation, and data-viz libraries. Import them by their npm specifier:

| Specifier | What it's for | Example import |
|---|---|---|
| `react`, `react-dom` | React 18 | `import React, { useState, useEffect, useRef } from 'react'` |
| `three` | 3D scenes (WebGL) | `import * as THREE from 'three'` |
| `pixi.js` | Fast 2D WebGL (sprites, particles) | `import * as PIXI from 'pixi.js'` |
| `d3` | Data viz primitives, scales, selections | `import * as d3 from 'd3'` |
| `recharts` | React-native charts (LineChart, BarChart, …) | `import { LineChart, Line, XAxis, YAxis } from 'recharts'` |
| `framer-motion` | Declarative React animation | `import { motion } from 'framer-motion'` |
| `mermaid` | Render flowcharts/sequence diagrams from text | `import mermaid from 'mermaid'` |
| `matter-js` | 2D rigid-body physics | `import Matter from 'matter-js'` |
| `simplex-noise` | Procedural noise (terrain, textures) | `import { SimplexNoise } from 'simplex-noise'` |
| `tsparticles` | Particle effects from a config object | `import { tsParticles, loadFull } from 'tsparticles'` |

Any other specifier (e.g. `lodash`, `chart.js`, CSS imports) will throw `Module "X" is not available in the React sandbox` at runtime.

### Canvas-based libraries (three, pixi, matter, mermaid)

These render to a `<canvas>` or `<div>` rather than emitting React elements. Mount inside `useEffect` against a `useRef` element, and clean up on unmount:

```tsx
import * as THREE from 'three';

function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = mountRef.current!;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, el.clientWidth / el.clientHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);
    // … set up scene, animate via requestAnimationFrame …
    return () => { renderer.dispose(); el.removeChild(renderer.domElement); };
  }, []);
  return <div ref={mountRef} style={{ width: 400, height: 300 }} />;
}
```

### React-native libraries (recharts, framer-motion)

Use these like ordinary React components — no refs or effects needed:

```tsx
import { motion } from 'framer-motion';
import { LineChart, Line, XAxis, YAxis, Tooltip } from 'recharts';

const data = [{ x: 0, y: 4 }, { x: 1, y: 9 }, { x: 2, y: 5 }];

function App() {
  return (
    <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 2 }}>
      <LineChart width={400} height={200} data={data}>
        <XAxis dataKey="x" /><YAxis /><Tooltip />
        <Line type="monotone" dataKey="y" stroke="#8884d8" />
      </LineChart>
    </motion.div>
  );
}
```

## Sandbox

The iframe is `sandbox="allow-scripts"` with a `null` origin. It cannot read host cookies, `localStorage`, the parent DOM, or other tabs. `fetch` works but cross-origin reads need CORS.

## Environment notes

- **Don't mount the component yourself.** The host calls `ReactDOM.createRoot(...).render(<App/>)`. Do not call `createRoot` / `render` / `hydrateRoot` in the snippet — it'll fight the host's mount.
- **No data or file access.** The iframe can't see DuckDB tables, sandbox files, or anything `LoadData` produced. To display data, inline it as a literal in the snippet (compute the values in `RunPython` / `RunSQL` first and paste them in).
- **Styling is inline or `<style>`.** `style={{...}}` props work directly. For class-based styling, include a `<style>` element inside `App`'s tree. CSS imports are not supported.

## Error symptom → cause

- `App is not defined` → snippet didn't define an `App` component; rename your top-level component to `App`.
- `Module "X" is not available in the React sandbox` → you imported a library outside the supported list above (see "Available libraries"). Either switch to one of the supported libraries, or drop the import and inline the behaviour.
- `Invalid hook call` / `Hooks can only be called inside the body of a function component` → you called a hook outside `App` or in a regular helper; move it inside the component.
