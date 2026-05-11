/**
 * ESM bootstrap loaded by the React sandbox iframe as a `<script type="module">`.
 *
 * Each `import` here is resolved by Vite's dep optimizer into a self-contained
 * bundle, so the iframe receives one transformed file with all bare specifiers
 * inlined. The iframe then exposes the libraries on `globalThis` so the sandbox
 * `require` shim (in `reactSandbox.ts`) can hand them back to user code
 * synchronously.
 *
 * Loaded in a separate file from `reactSandbox.ts` so Vite treats each library
 * as its own pre-bundled dependency, and so the iframe can fetch this file via
 * `?url` and execute it cross-origin.
 *
 * UMD libraries (React, ReactDOM, d3, framer-motion, mermaid, matter-js)
 * are not loaded here — they go straight into `<script src>` tags in
 * `reactSandbox.ts`. Only libraries that ship ESM-only (three, pixi, simplex)
 * or that need a Vite-bundled wrapper (react-is for recharts, tsparticles +
 * its engine package) come through this file.
 */
import * as THREE from 'three';
import * as PIXI from 'pixi.js';
import * as SimplexNoise from 'simplex-noise';
import * as ReactIs from 'react-is';
import * as TsparticlesEngine from '@tsparticles/engine';
import { loadFull } from 'tsparticles';

interface SandboxGlobals {
  THREE: typeof THREE;
  PIXI: typeof PIXI;
  SimplexNoise: typeof SimplexNoise;
  ReactIs: typeof ReactIs;
  tsParticles: typeof TsparticlesEngine.tsParticles;
  loadFull: typeof loadFull;
}

const g = globalThis as typeof globalThis & Partial<SandboxGlobals>;
g.THREE = THREE;
g.PIXI = PIXI;
g.SimplexNoise = SimplexNoise;
g.ReactIs = ReactIs;
g.tsParticles = TsparticlesEngine.tsParticles;
g.loadFull = loadFull;

window.dispatchEvent(new Event('__sandboxLibsReady'));
