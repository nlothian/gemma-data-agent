const PYODIDE_VERSION = '0.29.3';
const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const WORKER_SOURCE = `
import { loadPyodide } from "${PYODIDE_INDEX_URL}pyodide.mjs";

const pyodideReady = loadPyodide({ indexURL: "${PYODIDE_INDEX_URL}" });

pyodideReady
  .then(() => self.postMessage({ type: "ready" }))
  .catch((err) =>
    self.postMessage({
      type: "init-error",
      error: err && err.message ? err.message : String(err),
    })
  );

const ARROW_INPUT_PREAMBLE =
  "arrow_inputs = {k: bytes(v) for k, v in __arrow_inputs_raw.items()}\\n" +
  "del __arrow_inputs_raw\\n";

self.onmessage = async (event) => {
  const data = event.data;
  if (!data || typeof data.id !== "number") return;
  const { id, python, inputs } = data;
  const stdout = [];
  const stderr = [];
  let ns = null;
  try {
    const pyodide = await pyodideReady;
    pyodide.setStdout({ batched: (s) => stdout.push(s) });
    pyodide.setStderr({ batched: (s) => stderr.push(s) });
    ns = pyodide.globals.get("dict")();

    let source = python;
    if (Array.isArray(inputs) && inputs.length > 0) {
      const raw = {};
      for (const item of inputs) {
        if (item && typeof item.name === "string" && item.buffer) {
          raw[item.name] = item.buffer;
        }
      }
      const rawPy = pyodide.toPy(raw);
      ns.set("__arrow_inputs_raw", rawPy);
      if (rawPy && typeof rawPy.destroy === "function") rawPy.destroy();
      source = ARROW_INPUT_PREAMBLE + python;
    }

    await pyodide.loadPackagesFromImports(source);
    const result = await pyodide.runPythonAsync(source, { globals: ns });
    let resultStr = "";
    if (result !== undefined && result !== null) {
      try {
        resultStr = result.toString();
      } catch (e) {
        resultStr = String(result);
      }
      if (result && typeof result.destroy === "function") {
        result.destroy();
      }
    }
    const arrowTables = [];
    const transferables = [];
    const tablesProxy = ns.get("arrow_tables");
    if (tablesProxy !== undefined && tablesProxy !== null) {
      try {
        const jsTables =
          typeof tablesProxy.toJs === "function"
            ? tablesProxy.toJs()
            : tablesProxy;
        const entries =
          jsTables instanceof Map
            ? Array.from(jsTables.entries())
            : jsTables && typeof jsTables === "object"
              ? Object.entries(jsTables)
              : [];
        for (const [name, raw] of entries) {
          let buffer;
          if (raw instanceof Uint8Array) {
            buffer = raw;
          } else if (raw && raw.buffer instanceof ArrayBuffer) {
            buffer = new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength);
          } else {
            continue;
          }
          arrowTables.push({ name: String(name), buffer });
          transferables.push(buffer.buffer);
        }
      } finally {
        if (tablesProxy && typeof tablesProxy.destroy === "function") {
          tablesProxy.destroy();
        }
      }
    }
    const msg = {
      id,
      ok: true,
      result: resultStr,
      stdout: stdout.join("\\n"),
      stderr: stderr.join("\\n"),
      arrowTables,
    };
    self.postMessage(msg, transferables);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error && error.message ? error.message : String(error),
      stdout: stdout.join("\\n"),
      stderr: stderr.join("\\n"),
    });
  } finally {
    if (ns && typeof ns.destroy === "function") {
      ns.destroy();
    }
  }
};
`;

export interface PyodideStatus {
  ready: boolean;
  error?: string;
}

export interface PyodideArrowTable {
  name: string;
  buffer: Uint8Array;
}

export interface PyodideArrowInput {
  name: string;
  buffer: Uint8Array;
}

export interface PyodideRunResult {
  ok: boolean;
  result?: string;
  error?: string;
  stdout: string;
  stderr: string;
  arrowTables?: PyodideArrowTable[];
}

interface RunResponseMessage extends PyodideRunResult {
  id: number;
}

type WorkerReply =
  | { type: 'ready' }
  | { type: 'init-error'; error: string }
  | RunResponseMessage;

let worker: Worker | null = null;
let status: PyodideStatus = { ready: false };
const subscribers = new Set<(s: PyodideStatus) => void>();
const pending = new Map<number, (r: PyodideRunResult) => void>();
let nextId = 1;

function setStatus(next: PyodideStatus) {
  status = next;
  subscribers.forEach((cb) => cb(next));
}

function ensureWorker() {
  if (worker || typeof window === 'undefined') return;

  const workerUrl = URL.createObjectURL(
    new Blob([WORKER_SOURCE], { type: 'text/javascript' })
  );
  const w = new Worker(workerUrl, { type: 'module' });
  URL.revokeObjectURL(workerUrl);

  w.onmessage = (event: MessageEvent<WorkerReply>) => {
    const data = event.data;
    if ('type' in data) {
      if (data.type === 'ready') {
        setStatus({ ready: true });
      } else if (data.type === 'init-error') {
        setStatus({ ready: false, error: data.error });
      }
      return;
    }
    const resolve = pending.get(data.id);
    if (resolve) {
      pending.delete(data.id);
      const { id: _id, ...rest } = data;
      resolve(rest);
    }
  };

  w.onerror = (event) => {
    setStatus({ ready: false, error: event.message });
  };

  worker = w;
}

export function getPyodideStatus(): PyodideStatus {
  ensureWorker();
  return status;
}

export function onPyodideStatusChange(
  cb: (s: PyodideStatus) => void
): () => void {
  ensureWorker();
  subscribers.add(cb);
  cb(status);
  return () => {
    subscribers.delete(cb);
  };
}

export function runPython(
  code: string,
  inputs: PyodideArrowInput[] = []
): Promise<PyodideRunResult> {
  ensureWorker();
  if (!worker) {
    return Promise.reject(
      new Error('Pyodide is not available in this environment.')
    );
  }
  const id = nextId++;
  const payloadInputs = inputs.map((i) => ({
    name: i.name,
    buffer: new Uint8Array(i.buffer),
  }));
  return new Promise<PyodideRunResult>((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ id, python: code, inputs: payloadInputs });
  });
}
