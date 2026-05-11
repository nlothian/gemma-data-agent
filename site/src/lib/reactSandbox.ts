/**
 * React execution sandbox.
 *
 * Compiles TypeScript + JSX with the bundled `typescript` package, then runs
 * the result inside a freshly-built `<iframe sandbox="allow-scripts">`. The
 * iframe boots React 18 + ReactDOM (UMD bundles served by Vite), exposes the
 * common hooks as globals, and posts ready / runtime-error messages back to
 * the host. The agent's snippet is expected to define a top-level `App`
 * component which the bootstrap script then mounts.
 *
 * The host side waits ~750 ms after the iframe loads so that effect-time
 * throws and unhandled-promise rejections are captured before the call
 * resolves.
 */
import { isBrowser } from './browser';

// React's package.json `exports` doesn't expose `./umd/*`, so import these
// via relative paths into node_modules to bypass the exports gate. Vite still
// fingerprints them as static assets and rewrites the URL on build.
import reactUmdUrl from '../../node_modules/react/umd/react.development.js?url';
import reactDomUmdUrl from '../../node_modules/react-dom/umd/react-dom.development.js?url';

// Graphics library UMDs. Each `<script src>` installs a window global the
// `require` shim below maps back to its npm specifier. See
// `reactSandboxLibs.ts` for the ESM-only libs (three, pixi, simplex-noise,
// react-is, tsparticles engine), which load through a separate module script.
import d3UmdUrl from '../../node_modules/d3/dist/d3.min.js?url';
import framerMotionUmdUrl from '../../node_modules/framer-motion/dist/framer-motion.js?url';
import mermaidUmdUrl from '../../node_modules/mermaid/dist/mermaid.min.js?url';
import matterUmdUrl from '../../node_modules/matter-js/build/matter.min.js?url';
import rechartsUmdUrl from '../../node_modules/recharts/umd/Recharts.js?url';
// `?worker&url` (not `?url`) so Vite runs the TS through its module pipeline:
// TypeScript is compiled, bare specifiers (three, pixi, …) are resolved to
// emitted chunks, and the result is a real ESM asset URL. With plain `?url`
// the file is treated as a raw asset — the production build would inline it
// as `data:video/mp2t;base64,…` (the default MIME for `.ts`) with the raw
// TypeScript source, and the browser refuses to import that as a module.
// We never actually instantiate this as a Worker; the iframe just `import()`s
// the URL to run its side-effects (set globals on `window`).
import sandboxLibsUrl from './reactSandboxLibs.ts?worker&url';

export interface ReactCompileError {
  message: string;
  line?: number;
  column?: number;
}

export interface ReactRuntimeError {
  message: string;
  stack?: string;
}

export type RunReactResult =
  | { ok: true; compileErrors: []; runtimeErrors: ReactRuntimeError[] }
  | {
      ok: false;
      compileErrors: ReactCompileError[];
      runtimeErrors: ReactRuntimeError[];
    };

// After the iframe signals 'rendered', wait this long before resolving so
// effect-time throws and unhandled rejections still land in the error list.
const POST_RENDER_WAIT_MS = 750;
// Hard cap for the whole run. Libraries (three, pixi, mermaid, …) take a
// noticeable amount of time to load on first run; after that they're cached.
const RUN_TIMEOUT_MS = 8000;

let mountElement: HTMLElement | null = null;
let mountWaiters: Array<(el: HTMLElement) => void> = [];

export function setReactMountElement(el: HTMLElement | null): void {
  mountElement = el;
  if (el) {
    const waiters = mountWaiters;
    mountWaiters = [];
    for (const w of waiters) w(el);
  }
}

async function awaitMountElement(timeoutMs = 5000): Promise<HTMLElement | null> {
  if (mountElement) return mountElement;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      mountWaiters = mountWaiters.filter((w) => w !== onSet);
      resolve(null);
    }, timeoutMs);
    const onSet = (el: HTMLElement): void => {
      clearTimeout(t);
      resolve(el);
    };
    mountWaiters.push(onSet);
  });
}

interface CompileOutcome {
  js: string;
  diagnostics: ReactCompileError[];
}

let tsModule: typeof import('typescript') | null = null;

async function loadTs(): Promise<typeof import('typescript')> {
  if (tsModule) return tsModule;
  tsModule = await import('typescript');
  return tsModule;
}

export async function compileReactSnippet(code: string): Promise<CompileOutcome> {
  const ts = await loadTs();
  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      // CommonJS so `import React from 'react'` (which the agent often emits
      // despite the prompt asking it not to) compiles to `require('react')`.
      // The sandbox bootstrap installs a `require` shim that maps known
      // specifiers to the React/ReactDOM globals.
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      jsxFactory: 'React.createElement',
      jsxFragmentFactory: 'React.Fragment',
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      isolatedModules: false,
      noEmitOnError: false,
    },
    reportDiagnostics: true,
    fileName: 'agent.tsx',
  });
  const diagnostics: ReactCompileError[] = (result.diagnostics ?? []).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (d.file && typeof d.start === 'number') {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      return { message, line: line + 1, column: character + 1 };
    }
    return { message };
  });
  return { js: result.outputText, diagnostics };
}

function absoluteUrl(relativeOrAbs: string): string {
  if (typeof window === 'undefined') return relativeOrAbs;
  return new URL(relativeOrAbs, window.location.origin).href;
}

function escapeForScript(s: string): string {
  // Prevent the user (or a transpiled output) from escaping the inline
  // <script> by closing the tag early. Splitting "</script" defeats the
  // browser's tokenizer without changing the runtime semantics.
  return s.replace(/<\/script/gi, '<\\/script');
}

interface SandboxLibUrls {
  react: string;
  reactDom: string;
  d3: string;
  framerMotion: string;
  mermaid: string;
  matter: string;
  recharts: string;
  libsModule: string;
}

function buildSrcdoc(userJs: string, urls: SandboxLibUrls): string {
  const safeUserJs = escapeForScript(userJs);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#111;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
  #root{padding:12px;}
</style>
</head>
<body>
<div id="root"></div>

<!-- UMDs that install their own window globals at parse time. Order matters:
     React first (other libs key off window.React); framer-motion last because
     its UMD reads window.React when it executes. -->
<script src="${urls.react}"></script>
<script src="${urls.reactDom}"></script>
<script src="${urls.d3}"></script>
<script src="${urls.mermaid}"></script>
<script src="${urls.matter}"></script>
<script src="${urls.framerMotion}"></script>

<script>
(function(){
  var R = window.React, RD = window.ReactDOM;
  window.useState = R.useState;
  window.useEffect = R.useEffect;
  window.useRef = R.useRef;
  window.useMemo = R.useMemo;
  window.useCallback = R.useCallback;
  window.useReducer = R.useReducer;
  window.useContext = R.useContext;

  // require() shim. User code is compiled to CommonJS so every \`import ... from 'X'\`
  // becomes \`require('X')\`. We map each known specifier to the global the
  // corresponding UMD/ESM bundle installs, and throw a clear error for anything
  // unknown so the failure shows up in the runtime-error list.
  function lookup(spec){
    switch (spec) {
      case 'react': return R;
      case 'react-dom':
      case 'react-dom/client': return RD;
      case 'd3': return window.d3;
      case 'three': return window.THREE;
      case 'pixi.js': return window.PIXI;
      case 'simplex-noise': return window.SimplexNoise;
      case 'framer-motion': return window.Motion;
      case 'mermaid': return window.mermaid;
      case 'matter-js': return window.Matter;
      case 'recharts': return window.Recharts;
      case 'react-is': return window.ReactIs;
      case 'tsparticles':
      case '@tsparticles/engine': return { tsParticles: window.tsParticles, loadFull: window.loadFull };
      default: return null;
    }
  }
  window.require = function(spec){
    var mod = lookup(spec);
    if (mod) return mod;
    throw new Error('Module "' + spec + '" is not available in the React sandbox.');
  };

  function send(type, payload) {
    try { parent.postMessage({ source: 'react-sandbox', type: type, payload: payload }, '*'); } catch(e) {}
  }
  window.__sendError = function(err){ send('runtime-error', err); };
  window.__sendRendered = function(){ send('rendered', null); };

  window.addEventListener('error', function(e){
    var err = e.error;
    send('runtime-error', { message: e.message || (err && err.message) || String(err), stack: err && err.stack });
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e.reason;
    send('runtime-error', { message: (r && r.message) || String(r), stack: r && r.stack });
  });

  function Boundary(props){ R.Component.call(this, props); this.state = { error: null }; }
  Boundary.prototype = Object.create(R.Component.prototype);
  Boundary.prototype.constructor = Boundary;
  Boundary.getDerivedStateFromError = function(error){ return { error: error }; };
  Boundary.prototype.componentDidCatch = function(error, info){
    send('runtime-error', { message: (error && error.message) || String(error), stack: (error && error.stack) || (info && info.componentStack) });
  };
  Boundary.prototype.render = function(){
    if (this.state.error) {
      return R.createElement('pre', { style: { color: '#c00', whiteSpace: 'pre-wrap', margin: 0 } }, String((this.state.error && this.state.error.message) || this.state.error));
    }
    return this.props.children;
  };
  window.__Boundary = Boundary;

  // CJS user code expects \`module\`, \`exports\`, \`require\` as globals. We
  // *don't* attach them to \`window\` yet — UMDs that load after this script
  // (notably recharts) sniff \`typeof exports\` and take a CJS branch if it
  // exists, which would set \`module.exports = Recharts\` instead of
  // \`window.Recharts\` and break the require shim. The window properties are
  // installed in \`__runUser\` below, just before the user snippet runs.
  window.__userSource = ${JSON.stringify(safeUserJs)} +
    '\\n;try{if(typeof App!=="undefined")window.module.exports.App=App;}catch(e){}';

  window.__runUser = function(){
    try {
      window.module = { exports: {} };
      window.exports = window.module.exports;
      // Injecting via textContent + appendChild runs synchronously as a
      // top-level classic script — parse errors fire window.onerror (already
      // wired above) instead of taking down the orchestrator.
      var s = document.createElement('script');
      s.textContent = window.__userSource;
      document.body.appendChild(s);

      var App = window.module.exports.App ||
        ((typeof window.App !== 'undefined') ? window.App :
         (typeof window.module.exports === 'function') ? window.module.exports :
         (window.module.exports && typeof window.module.exports.default === 'function') ? window.module.exports.default :
         null);
      if (!App) {
        window.__sendError({ message: 'Snippet must define a component named \`App\`.' });
        return;
      }
      var root = window.ReactDOM.createRoot(document.getElementById('root'));
      root.render(window.React.createElement(window.__Boundary, null, window.React.createElement(App)));
      window.__sendRendered();
    } catch (e) {
      window.__sendError({ message: (e && e.message) || String(e), stack: e && e.stack });
    }
  };

  send('ready', null);
})();
</script>

<!-- Module-bundled libraries (three, pixi, simplex-noise, react-is,
     tsparticles engine). The module imports each, sets the global, then
     dispatches \`__sandboxLibsReady\`. We then load the recharts UMD (which
     reads window.React/ReactDOM/ReactIs) and finally run the user code. -->
<script type="module">
(async function(){
  try {
    await import(${JSON.stringify(urls.libsModule)});
    await new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = ${JSON.stringify(urls.recharts)};
      s.onload = resolve;
      s.onerror = function(){ reject(new Error('Failed to load recharts')); };
      document.head.appendChild(s);
    });
    window.__runUser();
  } catch (e) {
    window.__sendError({ message: 'Sandbox library load failed: ' + ((e && e.message) || String(e)), stack: e && e.stack });
  }
})();
</script>
</body>
</html>`;
}

interface RunInIframeResult {
  runtimeErrors: ReactRuntimeError[];
}

async function runInIframe(js: string, mountEl: HTMLElement): Promise<RunInIframeResult> {
  // Tear down any previous iframe so each run starts from a clean slate.
  mountEl.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('title', 'React sandbox');
  iframe.style.cssText = 'width:100%;height:100%;border:0;background:#fff;display:block;';

  const errors: ReactRuntimeError[] = [];
  let renderedAt: number | null = null;

  const onMessage = (ev: MessageEvent): void => {
    if (ev.source !== iframe.contentWindow) return;
    const data = ev.data as { source?: string; type?: string; payload?: unknown } | null;
    if (!data || data.source !== 'react-sandbox') return;
    if (data.type === 'runtime-error' && data.payload) {
      errors.push(data.payload as ReactRuntimeError);
    } else if (data.type === 'rendered' && renderedAt === null) {
      renderedAt = Date.now();
    }
  };
  window.addEventListener('message', onMessage);

  const srcdoc = buildSrcdoc(js, {
    react: absoluteUrl(reactUmdUrl),
    reactDom: absoluteUrl(reactDomUmdUrl),
    d3: absoluteUrl(d3UmdUrl),
    framerMotion: absoluteUrl(framerMotionUmdUrl),
    mermaid: absoluteUrl(mermaidUmdUrl),
    matter: absoluteUrl(matterUmdUrl),
    recharts: absoluteUrl(rechartsUmdUrl),
    libsModule: absoluteUrl(sandboxLibsUrl),
  });
  iframe.srcdoc = srcdoc;
  mountEl.appendChild(iframe);

  // Wait for the iframe to either signal 'rendered' (then a short post-render
  // window for effect-time errors) or hit the hard timeout.
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (Date.now() - startedAt >= RUN_TIMEOUT_MS) {
        resolve();
        return;
      }
      if (renderedAt !== null && Date.now() - renderedAt >= POST_RENDER_WAIT_MS) {
        resolve();
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });

  window.removeEventListener('message', onMessage);
  // Drop the cross-origin "Script error." that browsers report alongside any
  // sandboxed-iframe throw — the same throw is already in the list with its
  // real message and stack from our error boundary or the iframe's own
  // rethrowing handler.
  const filtered = errors.filter(
    (e) => !(e.message === 'Script error.' && !e.stack),
  );
  return { runtimeErrors: filtered };
}

export async function runReactSandbox(code: string): Promise<RunReactResult> {
  if (!isBrowser()) {
    return {
      ok: false,
      compileErrors: [],
      runtimeErrors: [{ message: 'React sandbox can only run in the browser.' }],
    };
  }
  const { js, diagnostics } = await compileReactSnippet(code);
  if (diagnostics.length > 0) {
    return { ok: false, compileErrors: diagnostics, runtimeErrors: [] };
  }
  const mountEl = await awaitMountElement();
  if (!mountEl) {
    return {
      ok: false,
      compileErrors: [],
      runtimeErrors: [
        { message: 'React tab View pane is not mounted; cannot render.' },
      ],
    };
  }
  const { runtimeErrors } = await runInIframe(js, mountEl);
  if (runtimeErrors.length > 0) {
    return { ok: false, compileErrors: [], runtimeErrors };
  }
  return { ok: true, compileErrors: [], runtimeErrors: [] };
}
