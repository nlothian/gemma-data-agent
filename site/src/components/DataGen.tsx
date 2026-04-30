import { useCallback, useEffect, useState } from 'react';
import {
  type Workspace,
  pickWorkspace,
  restoreWorkspace,
  reauthorize,
  clearWorkspace,
  openJsonlAppender,
} from '../lib/datagen/workspace';
import {
  runTeacherTrajectory,
  resetRuntimeForTrajectory,
  type TrajectoryRecord,
  type TrajectoryTurn,
} from '../lib/datagen/trajectory';
import { useLLMConfig } from '../hooks/useLLMConfig';
import { setMode as setToolGateMode } from '../lib/toolDebugger';

type WorkspaceState =
  | { kind: 'idle' }
  | { kind: 'restored'; workspace: Workspace }
  | { kind: 'error'; message: string };

type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; turns: TrajectoryTurn[] }
  | { kind: 'done'; record: TrajectoryRecord }
  | { kind: 'error'; message: string };

const DEFAULT_TEACHER_MODEL = 'anthropic/claude-sonnet-4.5';

export default function DataGen() {
  const hasFsAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  const [wsState, setWsState] = useState<WorkspaceState>({ kind: 'idle' });
  const llm = useLLMConfig();
  const hasOpenrouterKey = Boolean(llm.config.apiKeys['https://openrouter.ai/api/v1']);

  const [teacherModel, setTeacherModel] = useState(DEFAULT_TEACHER_MODEL);
  const [userPrompt, setUserPrompt] = useState('');
  const [runState, setRunState] = useState<RunState>({ kind: 'idle' });

  useEffect(() => {
    if (!hasFsAccess) return;
    restoreWorkspace()
      .then((ws) => {
        if (ws) setWsState({ kind: 'restored', workspace: ws });
      })
      .catch((err: unknown) => setWsState({ kind: 'error', message: errorMessage(err) }));
  }, [hasFsAccess]);

  const onPick = useCallback(async () => {
    try {
      const ws = await pickWorkspace();
      setWsState({ kind: 'restored', workspace: ws });
    } catch (err) {
      if (isAbortError(err)) return;
      setWsState({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  const onClear = useCallback(async () => {
    await clearWorkspace();
    setWsState({ kind: 'idle' });
  }, []);

  const onReauth = useCallback(async () => {
    if (wsState.kind !== 'restored') return;
    try {
      await reauthorize(wsState.workspace);
    } catch (err) {
      setWsState({ kind: 'error', message: errorMessage(err) });
    }
  }, [wsState]);

  const onRun = useCallback(async () => {
    if (wsState.kind !== 'restored') {
      setRunState({ kind: 'error', message: 'Pick a workspace first.' });
      return;
    }
    if (!userPrompt.trim()) {
      setRunState({ kind: 'error', message: 'Enter a user prompt.' });
      return;
    }
    if (!hasOpenrouterKey) {
      setRunState({
        kind: 'error',
        message:
          'No OpenRouter API key found. Open the main app Settings, add an OpenRouter key, then come back.',
      });
      return;
    }

    const turns: TrajectoryTurn[] = [];
    setRunState({ kind: 'running', turns });

    // Tool dispatch is gated by Step/Play in the production chat UI. Data-gen
    // needs it open — flip to running before any tool call.
    setToolGateMode('running');
    await resetRuntimeForTrajectory();

    const runId = new Date().toISOString();
    const taskId = `manual-${runId}`;

    try {
      const record = await runTeacherTrajectory({
        mainConfig: llm.config,
        teacherModel,
        userPrompt,
        taskId,
        runId,
        sourcePipeline: 'gold',
        onTurn: (turn) => {
          turns.push(turn);
          setRunState({ kind: 'running', turns: [...turns] });
        },
      });
      const appender = await openJsonlAppender(wsState.workspace, 'output/trajectories.jsonl');
      await appender.append(record);
      setRunState({ kind: 'done', record });
    } catch (err) {
      setRunState({ kind: 'error', message: errorMessage(err) });
    }
  }, [wsState, llm.config, teacherModel, userPrompt, hasOpenrouterKey]);

  return (
    <section style={{ padding: '2rem', fontFamily: "'IBM Plex Sans', sans-serif", maxWidth: 860 }}>
      <h1 style={{ margin: '0 0 0.25rem' }}>haw data generation</h1>
      <p style={{ color: '#666', margin: '0 0 2rem' }}>
        Developer-only mode for building Gemma fine-tuning datasets. Runs the
        production agent loop against a local workspace directory and writes
        SFT / DPO JSONL.
      </p>

      <Card title="Workspace">
        {!hasFsAccess && (
          <p style={errStyle}>File System Access API is not available. Use Chrome, Edge, Brave, or Arc.</p>
        )}
        {hasFsAccess && wsState.kind === 'idle' && (
          <>
            <p style={{ margin: '0 0 0.75rem' }}>
              Pick a directory the harness can read datasets from and write JSONL outputs to.
            </p>
            <button style={btnStyle} onClick={onPick}>Pick workspace…</button>
          </>
        )}
        {hasFsAccess && wsState.kind === 'restored' && (
          <>
            <p style={{ margin: '0 0 0.75rem' }}>
              Active: <code>{wsState.workspace.name}</code>
            </p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button style={btnStyle} onClick={onPick}>Switch…</button>
              <button style={{ ...btnStyle, ...btnSecondary }} onClick={onReauth}>Re-grant permission</button>
              <button style={{ ...btnStyle, ...btnSecondary }} onClick={onClear}>Forget</button>
            </div>
          </>
        )}
        {wsState.kind === 'error' && <p style={errStyle}>{wsState.message}</p>}
      </Card>

      <Card title="Teacher (OpenRouter)">
        {!hasOpenrouterKey && (
          <p style={errStyle}>
            No OpenRouter API key in storage. Open the main app, go to Settings, select
            OpenRouter as a provider and paste your API key. Then return here — the key is shared.
          </p>
        )}
        <label style={labelStyle}>
          Model
          <input
            type="text"
            value={teacherModel}
            onChange={(e) => setTeacherModel(e.target.value)}
            placeholder="anthropic/claude-sonnet-4.5"
            style={inputStyle}
          />
        </label>
      </Card>

      <Card title="Test trajectory (one shot)">
        <label style={labelStyle}>
          User prompt
          <textarea
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            placeholder="e.g. Load https://example.com/sales.csv and tell me the top 5 product categories by revenue."
            style={{ ...inputStyle, minHeight: 80, fontFamily: 'inherit' }}
          />
        </label>
        <div style={{ marginTop: '0.75rem' }}>
          <button
            style={btnStyle}
            onClick={onRun}
            disabled={runState.kind === 'running'}
          >
            {runState.kind === 'running' ? 'Running…' : 'Run'}
          </button>
        </div>

        {runState.kind === 'running' && <TurnList turns={runState.turns} />}
        {runState.kind === 'done' && (
          <>
            <p style={{ margin: '1rem 0 0.5rem', fontWeight: 500 }}>
              Outcome: <code>{runState.record.outcome}</code>
              {runState.record.outcomeDetail && ` — ${runState.record.outcomeDetail}`}
              {' · '}
              {runState.record.turns.length} turn{runState.record.turns.length === 1 ? '' : 's'}
              {' · '}
              {(runState.record.durationMs / 1000).toFixed(1)}s
              {' · '}
              appended to <code>output/trajectories.jsonl</code>
            </p>
            <TurnList turns={runState.record.turns} />
          </>
        )}
        {runState.kind === 'error' && <p style={errStyle}>{runState.message}</p>}
      </Card>

      <Card title="Pipelines">
        <p style={{ color: '#888', margin: 0 }}>Gold / rejection-sampling / adversarial pipelines wire next.</p>
      </Card>
    </section>
  );
}

function TurnList({ turns }: { turns: TrajectoryTurn[] }) {
  if (turns.length === 0) return null;
  return (
    <ol style={{ marginTop: '1rem', paddingLeft: '1.25rem' }}>
      {turns.map((t, i) => (
        <li key={i} style={{ marginBottom: '0.75rem' }}>
          {t.prose && <div style={{ marginBottom: '0.25rem' }}>{t.prose}</div>}
          {t.kind === 'tool_call' && (
            <>
              <div style={codeStyle}>
                → {t.toolName}({truncate(JSON.stringify(t.args ?? {}), 200)})
              </div>
              <div style={{ ...codeStyle, color: t.resultError ? '#a33' : '#333' }}>
                ← {truncate(JSON.stringify(t.result ?? null), 200)}
              </div>
            </>
          )}
          {t.kind === 'final' && (
            <div style={{ color: '#040', fontWeight: 500 }}>final answer</div>
          )}
        </li>
      ))}
    </ol>
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

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
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

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.85rem',
  color: '#444',
  marginBottom: '0.5rem',
};

const inputStyle: React.CSSProperties = {
  display: 'block',
  marginTop: '0.25rem',
  width: '100%',
  padding: '0.4rem 0.55rem',
  fontSize: '0.95rem',
  border: '1px solid #ccc',
  borderRadius: 6,
  boxSizing: 'border-box',
};

const codeStyle: React.CSSProperties = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: '0.85rem',
  background: '#f6f6f6',
  padding: '0.3rem 0.5rem',
  borderRadius: 4,
  marginBottom: '0.15rem',
  whiteSpace: 'pre-wrap',
};

const errStyle: React.CSSProperties = { color: '#a33', margin: 0 };

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
