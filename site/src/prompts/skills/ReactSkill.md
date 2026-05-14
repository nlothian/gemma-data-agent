# React sandbox libraries

Reference card for the React sandbox's preloaded libraries. Fetched on demand via `CallSkill('react')`.

## Available libraries

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

## Canvas-based libraries (three, pixi, matter, mermaid)

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

## React-native libraries (recharts, framer-motion)

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
