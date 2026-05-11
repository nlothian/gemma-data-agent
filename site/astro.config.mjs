import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sourcecodePlugin from "./scripts/sourcecode-vite-plugin.mjs";

export default defineConfig({
  integrations: [mdx(), react()],
  vite: {
    plugins: [sourcecodePlugin()],
    server: {
      // The React sandbox iframe runs at a null origin (sandbox="allow-scripts"
      // with no allow-same-origin) and dynamically imports the bundled libs
      // module + recharts UMD from this dev server. Module imports require
      // CORS, so allow any origin.
      cors: true,
    },
    // Under pnpm, @uiw/react-codemirror's ESM lives in a nested .pnpm path and
    // resolves @codemirror/state through its own symlinked deps, while the
    // standalone include entry resolves through the top-level node_modules.
    // esbuild treats those two paths as separate modules and emits two copies,
    // breaking `instanceof Extension`. `dedupe` forces both resolutions to the
    // single canonical instance.
    resolve: {
      dedupe: [
        '@codemirror/state',
        '@codemirror/view',
        '@codemirror/language',
        '@codemirror/commands',
        '@codemirror/autocomplete',
        '@codemirror/lint',
        '@codemirror/search',
        '@codemirror/theme-one-dark',
        'codemirror',
      ],
    },
    optimizeDeps: {
      exclude: ['@duckdb/duckdb-wasm', '@mediapipe/tasks-genai'],
      // apache-arrow is only reached via the dynamic import of ./duckdb, so
      // Vite's static scan misses it. Pre-bundle it explicitly so the dep URL
      // is stable when the agent's tool wrappers eventually fire.
      // fflate is imported only inside a Web Worker (sourcecodeSync.worker.ts)
      // — Vite's main-thread scan misses worker imports in dev, so the first
      // worker spawn races a re-optimisation and fails.
      // typescript is dynamically imported only when the agent's React sandbox
      // tool first compiles a snippet (reactSandbox.ts). Pre-bundle it so the
      // dep URL hash is stable from page load and the lazy import doesn't race
      // a mid-session re-optimisation ("Failed to fetch dynamically imported
      // module .../deps/typescript.js?v=...").
      // CodeMirror lang packages each ship their own copy of @codemirror/state
      // and @codemirror/view; pre-bundling them together makes esbuild emit a
      // single shared instance, which is required for CodeMirror's
      // `instanceof Extension` checks to succeed (otherwise the SourcecodeFileViewer
      // and CodeView islands throw "Unrecognized extension value in extension set").
      // Transitive @uiw/react-codemirror deps (autocomplete, lint, search,
      // theme-one-dark, codemirror, basic-setup) are listed explicitly so they
      // don't get discovered late and trigger a mid-session re-optimisation.
      include: [
        'apache-arrow',
        'fflate',
        'typescript',
        // React sandbox iframe loads these via a Vite-bundled module
        // (`reactSandboxLibs.ts`). Pre-bundling keeps the dep URLs stable so
        // first iframe load doesn't race a re-optimisation.
        'three',
        'pixi.js',
        'simplex-noise',
        'react-is',
        '@tsparticles/engine',
        'tsparticles',
        '@codemirror/state',
        '@codemirror/view',
        '@codemirror/language',
        '@codemirror/commands',
        '@codemirror/autocomplete',
        '@codemirror/lint',
        '@codemirror/search',
        '@codemirror/theme-one-dark',
        '@codemirror/lang-javascript',
        '@codemirror/lang-python',
        '@codemirror/lang-sql',
        '@codemirror/lang-css',
        '@codemirror/lang-html',
        '@codemirror/lang-json',
        '@codemirror/lang-markdown',
        'codemirror',
        '@uiw/codemirror-extensions-basic-setup',
        '@uiw/react-codemirror',
      ],
    },
  },
});
