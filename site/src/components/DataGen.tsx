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
import {
  runGoldPipeline,
  type GoldPipelineProgress,
} from '../lib/datagen/goldPipeline';
import {
  runRejectionPipeline,
  type RejectionPipelineProgress,
} from '../lib/datagen/rejectionPipeline';
import {
  generateTasks,
  type TaskGenFlavor,
  type GenerateTasksResult,
} from '../lib/datagen/taskGen';
import { listDatasets, type DatasetEntry } from '../lib/datagen/datasetBrowser';
import { probeDataset, UnsupportedFormatError } from '../lib/datagen/probeDataset';
import { useLLMConfig } from '../hooks/useLLMConfig';
import { setMode as setToolGateMode } from '../lib/toolDebugger';
import {
  LOCAL_GEMMA_MODELS,
  DEFAULT_LOCAL_GEMMA_ID,
  type LocalGemmaId,
} from '../lib/localLlm/models';

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

  type GoldRunState =
    | { kind: 'idle' }
    | { kind: 'running'; progress: GoldPipelineProgress; abort: AbortController }
    | { kind: 'done'; progress: GoldPipelineProgress }
    | { kind: 'error'; message: string };
  const [goldState, setGoldState] = useState<GoldRunState>({ kind: 'idle' });
  const [goldMaxTasks, setGoldMaxTasks] = useState<string>('10');

  type RejectionRunState =
    | { kind: 'idle' }
    | { kind: 'running'; progress: RejectionPipelineProgress; abort: AbortController }
    | { kind: 'done'; progress: RejectionPipelineProgress }
    | { kind: 'error'; message: string };
  const [rejState, setRejState] = useState<RejectionRunState>({ kind: 'idle' });
  const [studentModelId, setStudentModelId] = useState<LocalGemmaId>(DEFAULT_LOCAL_GEMMA_ID);
  const [judgeModel, setJudgeModel] = useState<string>('anthropic/claude-haiku-4.5');
  const [rolloutsPerTask, setRolloutsPerTask] = useState<string>('8');
  const [rejMaxTasks, setRejMaxTasks] = useState<string>('5');

  type TaskGenState =
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; result: GenerateTasksResult }
    | { kind: 'error'; message: string };
  const [tgState, setTgState] = useState<TaskGenState>({ kind: 'idle' });
  const [tgFlavor, setTgFlavor] = useState<TaskGenFlavor>('normal');
  const [tgDataset, setTgDataset] = useState<string>('');
  const [tgSchema, setTgSchema] = useState<string>('');
  const [tgCount, setTgCount] = useState<string>('20');
  const [datasets, setDatasets] = useState<DatasetEntry[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(false);
  const [datasetsError, setDatasetsError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

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

  const onRunGold = useCallback(async () => {
    if (wsState.kind !== 'restored') return;
    if (!hasOpenrouterKey) return;
    const cap = goldMaxTasks.trim() === '' ? undefined : parseInt(goldMaxTasks, 10);
    if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0)) {
      setGoldState({ kind: 'error', message: 'Max tasks must be a positive integer or blank.' });
      return;
    }
    const abort = new AbortController();
    const initial: GoldPipelineProgress = {
      total: 0, skipped: 0, done: 0, succeeded: 0, failed: 0,
    };
    setGoldState({ kind: 'running', progress: initial, abort });
    try {
      const result = await runGoldPipeline({
        workspace: wsState.workspace,
        mainConfig: llm.config,
        teacherModel,
        maxTasks: cap,
        signal: abort.signal,
        onProgress: (p) => {
          setGoldState((s) => (s.kind === 'running' ? { ...s, progress: p } : s));
        },
      });
      setGoldState({ kind: 'done', progress: result });
    } catch (err) {
      setGoldState({ kind: 'error', message: errorMessage(err) });
    }
  }, [wsState, llm.config, teacherModel, goldMaxTasks, hasOpenrouterKey]);

  const onRunRejection = useCallback(async () => {
    if (wsState.kind !== 'restored') return;
    if (!hasOpenrouterKey) return;
    const N = parseInt(rolloutsPerTask, 10);
    if (!Number.isFinite(N) || N <= 0) {
      setRejState({ kind: 'error', message: 'Rollouts per task must be a positive integer.' });
      return;
    }
    const cap = rejMaxTasks.trim() === '' ? undefined : parseInt(rejMaxTasks, 10);
    if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0)) {
      setRejState({ kind: 'error', message: 'Max tasks must be a positive integer or blank.' });
      return;
    }
    const abort = new AbortController();
    const initial: RejectionPipelineProgress = {
      total: 0, skipped: 0, done: 0, pairsEmitted: 0, successes: 0, failures: 0,
    };
    setRejState({ kind: 'running', progress: initial, abort });
    try {
      const result = await runRejectionPipeline({
        workspace: wsState.workspace,
        mainConfig: llm.config,
        studentModelId,
        judgeModel,
        rolloutsPerTask: N,
        maxTasks: cap,
        signal: abort.signal,
        onProgress: (p) => {
          setRejState((s) => (s.kind === 'running' ? { ...s, progress: p } : s));
        },
      });
      setRejState({ kind: 'done', progress: result });
    } catch (err) {
      setRejState({ kind: 'error', message: errorMessage(err) });
    }
  }, [wsState, llm.config, studentModelId, judgeModel, rolloutsPerTask, rejMaxTasks, hasOpenrouterKey]);

  const refreshDatasets = useCallback(async () => {
    if (wsState.kind !== 'restored') return;
    setDatasetsLoading(true);
    setDatasetsError(null);
    try {
      const list = await listDatasets(wsState.workspace);
      setDatasets(list);
    } catch (err) {
      setDatasetsError(errorMessage(err));
    } finally {
      setDatasetsLoading(false);
    }
  }, [wsState]);

  // Auto-list datasets when a workspace becomes available.
  useEffect(() => {
    if (wsState.kind === 'restored') void refreshDatasets();
    else setDatasets([]);
  }, [wsState, refreshDatasets]);

  const onSelectDataset = useCallback(async (path: string) => {
    setTgDataset(path);
    setProbeError(null);
    if (!path || wsState.kind !== 'restored') return;
    setProbing(true);
    try {
      const probe = await probeDataset(wsState.workspace, path);
      setTgSchema(probe.formattedSummary);
    } catch (err) {
      if (err instanceof UnsupportedFormatError) {
        setProbeError(err.message + ' Fill the schema summary by hand.');
      } else {
        setProbeError(`Probe failed: ${errorMessage(err)}`);
      }
    } finally {
      setProbing(false);
    }
  }, [wsState]);

  const onGenerateTasks = useCallback(async () => {
    if (wsState.kind !== 'restored') return;
    if (!hasOpenrouterKey) return;
    if (!tgDataset.trim() || !tgSchema.trim()) {
      setTgState({ kind: 'error', message: 'Provide dataset path and schema summary.' });
      return;
    }
    const count = parseInt(tgCount, 10);
    if (!Number.isFinite(count) || count <= 0) {
      setTgState({ kind: 'error', message: 'Count must be a positive integer.' });
      return;
    }
    setTgState({ kind: 'running' });
    try {
      const result = await generateTasks({
        workspace: wsState.workspace,
        mainConfig: llm.config,
        teacherModel,
        flavor: tgFlavor,
        dataset: { path: tgDataset, schemaSummary: tgSchema },
        count,
      });
      setTgState({ kind: 'done', result });
    } catch (err) {
      setTgState({ kind: 'error', message: errorMessage(err) });
    }
  }, [wsState, llm.config, teacherModel, tgFlavor, tgDataset, tgSchema, tgCount, hasOpenrouterKey]);

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

      <Card title="Generate task corpus (teacher → tasks/*.jsonl)">
        <p style={{ margin: '0 0 0.75rem', color: '#444' }}>
          Have the teacher generate a batch of user prompts for a dataset.
          <strong> Normal</strong> mixes lookup / aggregate / plot tasks.
          <strong> Adversarial</strong> targets known weak spots (schema
          traps, false premises, refusal probes).
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <label style={labelStyle}>
            Flavor
            <select
              value={tgFlavor}
              onChange={(e) => setTgFlavor(e.target.value as TaskGenFlavor)}
              style={inputStyle}
            >
              <option value="normal">normal</option>
              <option value="adversarial">adversarial</option>
            </select>
          </label>
          <label style={labelStyle}>
            Count
            <input
              type="text"
              value={tgCount}
              onChange={(e) => setTgCount(e.target.value)}
              style={inputStyle}
            />
          </label>
        </div>
        <label style={labelStyle}>
          Dataset
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
            <select
              value={tgDataset}
              onChange={(e) => onSelectDataset(e.target.value)}
              style={{ ...inputStyle, flex: 1, marginTop: 0 }}
              disabled={datasetsLoading || datasets.length === 0}
            >
              <option value="">{datasetsLoading ? 'Reading workspace…' : datasets.length === 0 ? 'No data files in workspace' : '— pick a file —'}</option>
              {datasets.map((d) => (
                <option key={d.path} value={d.path}>
                  {d.path} ({formatBytes(d.size)})
                </option>
              ))}
            </select>
            <button
              type="button"
              style={{ ...btnStyle, ...btnSecondary }}
              onClick={refreshDatasets}
              disabled={datasetsLoading || wsState.kind !== 'restored'}
              title="Re-read the workspace directory"
            >
              ↻
            </button>
          </div>
        </label>
        {datasetsError && <p style={errStyle}>{datasetsError}</p>}
        <label style={labelStyle}>
          Schema summary {probing && <span style={{ color: '#888' }}>(probing via DuckDB…)</span>}
          <textarea
            value={tgSchema}
            onChange={(e) => setTgSchema(e.target.value)}
            placeholder={`Pick a CSV / Parquet / JSON file above and we'll fill this in via DuckDB. Or write it by hand if the format isn't supported.`}
            style={{ ...inputStyle, minHeight: 140, fontFamily: "'IBM Plex Mono', monospace", fontSize: '0.85rem' }}
          />
        </label>
        {probeError && <p style={errStyle}>{probeError}</p>}
        <div style={{ marginTop: '0.75rem' }}>
          <button
            style={btnStyle}
            disabled={tgState.kind === 'running' || wsState.kind !== 'restored' || !hasOpenrouterKey}
            onClick={onGenerateTasks}
          >
            {tgState.kind === 'running' ? 'Generating…' : 'Generate tasks'}
          </button>
        </div>
        {tgState.kind === 'done' && (
          <p style={{ marginTop: '0.75rem' }}>
            Wrote {tgState.result.tasksWritten} task{tgState.result.tasksWritten === 1 ? '' : 's'}
            {' '}to <code>{tgState.result.outputFile}</code>.
          </p>
        )}
        {tgState.kind === 'error' && <p style={errStyle}>{tgState.message}</p>}
      </Card>

      <Card title="Gold pipeline (corpus → trajectories.jsonl)">
        <p style={{ margin: '0 0 0.75rem', color: '#444' }}>
          Reads <code>tasks/*.jsonl</code> from the workspace, runs the
          teacher loop on each task, appends to{' '}
          <code>output/trajectories.jsonl</code>. Skips taskIds already
          present so the run is resumable.
        </p>
        <label style={labelStyle}>
          Max tasks (blank = whole corpus)
          <input
            type="text"
            value={goldMaxTasks}
            onChange={(e) => setGoldMaxTasks(e.target.value)}
            placeholder="10"
            style={{ ...inputStyle, width: 120 }}
          />
        </label>
        <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
          <button
            style={btnStyle}
            disabled={goldState.kind === 'running' || wsState.kind !== 'restored' || !hasOpenrouterKey}
            onClick={onRunGold}
          >
            {goldState.kind === 'running' ? 'Running…' : 'Run gold pipeline'}
          </button>
          {goldState.kind === 'running' && (
            <button
              style={{ ...btnStyle, ...btnSecondary }}
              onClick={() => goldState.abort.abort()}
            >
              Stop
            </button>
          )}
        </div>
        {goldState.kind === 'running' && <ProgressView p={goldState.progress} />}
        {goldState.kind === 'done' && <ProgressView p={goldState.progress} />}
        {goldState.kind === 'error' && <p style={errStyle}>{goldState.message}</p>}
      </Card>

      <Card title="Rejection sampling (student rollouts → dpo.jsonl)">
        <p style={{ margin: '0 0 0.75rem', color: '#444' }}>
          For each task in the corpus that has a gold reference, run N
          student rollouts, judge each clean rollout's final answer
          against the gold, then emit DPO pairs. Reads gold answers from
          the trajectories.jsonl produced by the gold pipeline.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <label style={labelStyle}>
            Student model
            <select
              value={studentModelId}
              onChange={(e) => setStudentModelId(e.target.value as LocalGemmaId)}
              style={inputStyle}
            >
              {LOCAL_GEMMA_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Judge model (OpenRouter)
            <input
              type="text"
              value={judgeModel}
              onChange={(e) => setJudgeModel(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Rollouts per task
            <input
              type="text"
              value={rolloutsPerTask}
              onChange={(e) => setRolloutsPerTask(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Max tasks (blank = whole corpus)
            <input
              type="text"
              value={rejMaxTasks}
              onChange={(e) => setRejMaxTasks(e.target.value)}
              style={inputStyle}
            />
          </label>
        </div>
        <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
          <button
            style={btnStyle}
            disabled={rejState.kind === 'running' || wsState.kind !== 'restored' || !hasOpenrouterKey}
            onClick={onRunRejection}
          >
            {rejState.kind === 'running' ? 'Running…' : 'Run rejection sampling'}
          </button>
          {rejState.kind === 'running' && (
            <button
              style={{ ...btnStyle, ...btnSecondary }}
              onClick={() => rejState.abort.abort()}
            >
              Stop
            </button>
          )}
        </div>
        {(rejState.kind === 'running' || rejState.kind === 'done') && (
          <RejectionProgressView p={rejState.progress} />
        )}
        {rejState.kind === 'error' && <p style={errStyle}>{rejState.message}</p>}
      </Card>
    </section>
  );
}

function RejectionProgressView({ p }: { p: RejectionPipelineProgress }) {
  return (
    <div style={{ marginTop: '0.75rem', fontFamily: "'IBM Plex Mono', monospace", fontSize: '0.85rem' }}>
      <div>
        Tasks: {p.total} total · {p.skipped} skipped (no gold ref / already done) · {p.done} done
      </div>
      <div>
        Rollouts: {p.successes} ✓ / {p.failures} ✗ · DPO pairs emitted: {p.pairsEmitted}
      </div>
      {p.current && <div>Now: <code>{p.current.taskId}</code></div>}
      {p.lastNote && <div style={{ color: '#888' }}>{p.lastNote}</div>}
    </div>
  );
}

function ProgressView({ p }: { p: GoldPipelineProgress }) {
  return (
    <div style={{ marginTop: '0.75rem', fontFamily: "'IBM Plex Mono', monospace", fontSize: '0.85rem' }}>
      <div>
        Total: {p.total} · Skipped (already done): {p.skipped} · Run: {p.done}
        {' '}({p.succeeded} ✓ / {p.failed} ✗)
      </div>
      {p.current && <div>Now: <code>{p.current.taskId}</code></div>}
      {p.lastRecord && (
        <div style={{ color: p.lastRecord.outcome === 'completed' ? '#040' : '#a33' }}>
          Last: <code>{p.lastRecord.taskId}</code> → {p.lastRecord.outcome}
          {' · '}
          {p.lastRecord.turns.length} turns
          {' · '}
          {(p.lastRecord.durationMs / 1000).toFixed(1)}s
        </div>
      )}
    </div>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
