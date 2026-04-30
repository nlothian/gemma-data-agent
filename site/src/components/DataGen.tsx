import { useCallback, useEffect, useState } from 'react';
import {
  type Workspace,
  pickWorkspace,
  restoreWorkspace,
  reauthorize,
  clearWorkspace,
} from '../lib/datagen/workspace';

type WorkspaceState =
  | { kind: 'idle' }
  | { kind: 'restored'; workspace: Workspace; needsAuth: boolean }
  | { kind: 'error'; message: string };

export default function DataGen() {
  const hasFsAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  const [state, setState] = useState<WorkspaceState>({ kind: 'idle' });

  useEffect(() => {
    if (!hasFsAccess) return;
    restoreWorkspace()
      .then((ws) => {
        if (!ws) return;
        // We can't tell directly whether permission is still granted without
        // calling queryPermission, which restoreWorkspace already did. If the
        // returned workspace handle requires a re-grant, the caller (us) will
        // see permission errors on first I/O — surface a "reauthorize" button.
        setState({ kind: 'restored', workspace: ws, needsAuth: false });
      })
      .catch((err: unknown) => {
        setState({ kind: 'error', message: errorMessage(err) });
      });
  }, [hasFsAccess]);

  const onPick = useCallback(async () => {
    try {
      const ws = await pickWorkspace();
      setState({ kind: 'restored', workspace: ws, needsAuth: false });
    } catch (err) {
      if (isAbortError(err)) return;
      setState({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  const onClear = useCallback(async () => {
    await clearWorkspace();
    setState({ kind: 'idle' });
  }, []);

  const onReauth = useCallback(async () => {
    if (state.kind !== 'restored') return;
    try {
      await reauthorize(state.workspace);
      setState({ kind: 'restored', workspace: state.workspace, needsAuth: false });
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) });
    }
  }, [state]);

  return (
    <section style={{ padding: '2rem', fontFamily: "'IBM Plex Sans', sans-serif", maxWidth: 760 }}>
      <h1 style={{ margin: '0 0 0.25rem' }}>haw data generation</h1>
      <p style={{ color: '#666', margin: '0 0 2rem' }}>
        Developer-only mode for building Gemma fine-tuning datasets. Runs the
        production agent loop against a local workspace directory and writes
        SFT / DPO JSONL.
      </p>

      <Card title="Workspace">
        {!hasFsAccess && (
          <p style={{ color: '#a33' }}>
            File System Access API is not available. Use Chrome, Edge, Brave, or Arc.
          </p>
        )}
        {hasFsAccess && state.kind === 'idle' && (
          <>
            <p style={{ margin: '0 0 0.75rem' }}>
              Pick a directory the harness can read datasets from and write JSONL
              outputs to. Suggested layout:
            </p>
            <pre style={preStyle}>{`workspace/
  datasets/   (your CSVs / Parquets)
  tasks/      (task corpora, JSONL)
  output/
    sft.jsonl
    dpo.jsonl
    eval.jsonl
    runs/<timestamp>/`}</pre>
            <button style={btnStyle} onClick={onPick}>Pick workspace…</button>
          </>
        )}
        {hasFsAccess && state.kind === 'restored' && (
          <>
            <p style={{ margin: '0 0 0.75rem' }}>
              Active: <code>{state.workspace.name}</code>
            </p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button style={btnStyle} onClick={onPick}>Switch…</button>
              <button style={{ ...btnStyle, ...btnSecondary }} onClick={onReauth}>Re-grant permission</button>
              <button style={{ ...btnStyle, ...btnSecondary }} onClick={onClear}>Forget</button>
            </div>
          </>
        )}
        {state.kind === 'error' && (
          <p style={{ color: '#a33' }}>{state.message}</p>
        )}
      </Card>

      <Card title="Pipelines">
        <p style={{ color: '#888', margin: 0 }}>Wiring in progress.</p>
      </Card>
    </section>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1rem' }}>
      <h2 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 600 }}>{title}</h2>
      {children}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: '0.95rem',
  padding: '0.45rem 0.9rem',
  background: '#1a1a1a',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};

const btnSecondary: React.CSSProperties = {
  background: 'transparent',
  color: '#1a1a1a',
  border: '1px solid #ccc',
};

const preStyle: React.CSSProperties = {
  background: '#f6f6f6',
  padding: '0.6rem 0.8rem',
  borderRadius: 6,
  fontSize: '0.85rem',
  fontFamily: "'IBM Plex Mono', monospace",
  margin: '0 0 0.75rem',
};

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
