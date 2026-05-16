import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sourcecodePlugin from "./scripts/sourcecode-vite-plugin.mjs";

export default defineConfig({
  integrations: [mdx(), react()],
  // The React sandbox iframe runs at a null origin (sandbox="allow-scripts"
  // with no allow-same-origin) and dynamically imports its bundled libs chunk
  // from the same host that served the page. Null-origin module imports need
  // an explicit CORS allowance. Astro's static preview server ignores
  // `vite.preview.cors`, but it does forward `server.headers` to Vite — so we
  // set the CORS header here and it covers both `astro dev` (via Vite's dev
  // middleware) and `astro preview`.
  server: {
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
  vite: {
    plugins: [sourcecodePlugin()],
    server: {
      cors: true,
    },
    // The React sandbox iframe loads `reactSandboxLibs.ts` via `?worker&url`
    // so Vite bundles it instead of treating it as a raw `.ts` asset. We need
    // ES-module output (not the default IIFE) because the iframe consumes the
    // chunk via `await import(...)` and we want deps (three, pixi, …) to stay
    // as separate chunks rather than being inlined into one multi-MB blob.
    worker: {
      format: 'es',
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
      // pixi.js v8 internally code-splits its renderers (browserAll, WebGPU /
      // WebGL / Canvas renderers) via top-level dynamic imports. When Vite
      // pre-bundles pixi.js, those dynamic imports become separate
      // `.vite/deps/chunk-*.js` files whose `?v=` hash is computed
      // independently from the parent `pixi__js.js?v=…` hash. Mid-session HMR
      // can leave the parent and its children at different `?v=` values, and
      // the iframe ends up evaluating Pixi's `extensions.add('shape-builder',
      // …)` twice — failing with `Extension type shape-builder already has a
      // handler`. Excluding pixi.js makes Vite leave the bare specifier alone
      // and the iframe fetches the package's native ESM tree from
      // `/node_modules/pixi.js/...` directly; the browser dedupes by URL, so
      // the extension singleton is registered exactly once.
      exclude: ['@duckdb/duckdb-wasm', '@mediapipe/tasks-genai', 'pixi.js'],
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
        // pixi.js is `exclude`d above, so Vite serves its raw native ESM tree
        // and never scans its dependency graph. Pixi's CommonJS deps therefore
        // bypass dep pre-bundling, and esbuild's CJS->ESM interop never runs on
        // them — the React sandbox fetches the raw CJS file and the browser
        // throws "does not provide an export named 'default'" (seen with
        // eventemitter3, parse-svg-path, …). The fix is bounded, not
        // whack-a-mole: this list is exactly pixi.js's declared runtime
        // `dependencies` (version-pinned via package-lock.json, type-only
        // @types/earcut + @webgpu/types omitted as they have no runtime
        // import). Pre-bundling the whole set once covers every current and
        // future interop failure from this excluded package; it only changes
        // on a deliberate pixi upgrade. ESM-native entries (earcut, tiny-lru)
        // don't need interop but are kept so the list mirrors pixi's deps and
        // survives a dep flipping CJS<->ESM in a patch release.
        '@pixi/colord',
        '@xmldom/xmldom',
        'earcut',
        'eventemitter3',
        'gifuct-js',
        'ismobilejs',
        'parse-svg-path',
        'tiny-lru',
        // React sandbox iframe loads these via a Vite-bundled module
        // (`reactSandboxLibs.ts`). Pre-bundling keeps the dep URLs stable so
        // first iframe load doesn't race a re-optimisation.
        'three',
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
