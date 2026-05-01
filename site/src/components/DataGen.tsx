import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type OutputDir,
  pickOutputDirectory,
  restoreOutputDirectory,
  reauthorize as reauthorizeOutput,
  clearOutputDirectory,
  openJsonlAppender,
} from '../lib/datagen/outputDir';
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
import { probeDataset, UnsupportedFormatError } from '../lib/datagen/probeDataset';
import { useLLMConfig } from '../hooks/useLLMConfig';
import useSandboxConfig from '../hooks/useSandboxConfig';
import useProviderModels from '../hooks/useProviderModels';
import ModelPickerCell from './ModelPickerCell';
import { setMode as setToolGateMode } from '../lib/toolDebugger';
import {
  LOCAL_GEMMA_MODELS,
  DEFAULT_LOCAL_GEMMA_ID,
  type LocalGemmaId,
} from '../lib/localLlm/models';

type OutputDirState =
  | { kind: 'idle' }
  | { kind: 'restored'; outputDir: OutputDir }
  | { kind: 'error'; message: string };

type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; turns: TrajectoryTurn[] }
  | { kind: 'done'; record: TrajectoryRecord }
  | { kind: 'error'; message: string };

const DEFAULT_TEACHER_MODEL = 'anthropic/claude-sonnet-4.5';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';

const DATA_EXTENSIONS = new Set(['csv', 'tsv', 'parquet', 'json', 'jsonl', 'xlsx']);

export default function DataGen() {
  const hasFsAccess = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  const llm = useLLMConfig();
  const sandbox = useSandboxConfig();
  const providerModels = useProviderModels();
  const openrouterKey = llm.config.apiKeys[OPENROUTER_ENDPOINT] ?? '';
  const hasOpenrouterKey = openrouterKey.trim() !== '';
  const orModelsEntry = providerModels.getEntry(OPENROUTER_ENDPOINT);
  const refreshOrModels = useCallback(
    () => providerModels.refresh(OPENROUTER_ENDPOINT, openrouterKey),
    [providerModels, openrouterKey],
  );

  const [outState, setOutState] = useState<OutputDirState>({ kind: 'idle' });

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
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  // Restore output dir handle on mount.
  useEffect(() => {
    if (!hasFsAccess) return;
    restoreOutputDirectory()
      .then((od) => {
        if (od) setOutState({ kind: 'restored', outputDir: od });
      })
      .catch((err: unknown) => setOutState({ kind: 'error', message: errorMessage(err) }));
  }, [hasFsAccess]);

  // Filter sandbox files to data-loadable extensions for the dataset picker.
  const datasets = useMemo(
    () =>
      sandbox.files
        .filter((f) => DATA_EXTENSIONS.has(f.ext))
        .map((f) => ({ path: f.relativePath, size: f.sizeBytes })),
    [sandbox.files],
  );

  const sandboxReady = sandbox.status === 'permitted';
  const outputReady = outState.kind === 'restored';
  const allReady = sandboxReady && outputReady && hasOpenrouterKey;

  // ---- Output dir handlers ----

  const onPickOutput = useCallback(async () => {
    try {
      const od = await pickOutputDirectory();
      setOutState({ kind: 'restored', outputDir: od });
    } catch (err) {
      if (isAbortError(err)) return;
      setOutState({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  const onClearOutput = useCallback(async () => {
    await clearOutputDirectory();
    setOutState({ kind: 'idle' });
  }, []);

  const onReauthOutput = useCallback(async () => {
    if (outState.kind !== 'restored') return;
    try {
      await reauthorizeOutput(outState.outputDir);
    } catch (err) {
      setOutState({ kind: 'error', message: errorMessage(err) });
    }
  }, [outState]);

  // ---- One-shot test ----

  const onRun = useCallback(async () => {
    if (!sandboxReady) {
      setRunState({ kind: 'error', message: 'Pick a sandbox directory first.' });
      return;
    }
    if (!outputReady) {
      setRunState({ kind: 'error', message: 'Pick an output directory first.' });
      return;
    }
    if (!userPrompt.trim()) {
      setRunState({ kind: 'error', message: 'Enter a user prompt.' });
      return;
    }
    if (!hasOpenrouterKey) {
      setRunState({
        kind: 'error',
        message: 'No OpenRouter API key found. Add one in main app Settings.',
      });
      return;
    }

    const turns: TrajectoryTurn[] = [];
    setRunState({ kind: 'running', turns });

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
      const appender = await openJsonlAppender(
        (outState as { outputDir: OutputDir }).outputDir,
        'trajectories.jsonl',
      );
      await appender.append(record);
      setRunState({ kind: 'done', record });
    } catch (err) {
      setRunState({ kind: 'error', message: errorMessage(err) });
    }
  }, [outState, llm.config, teacherModel, userPrompt, hasOpenrouterKey, sandboxReady, outputReady]);

  const onRunGold = useCallback(async () => {
    if (!allReady || outState.kind !== 'restored') return;
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
        outputDir: outState.outputDir,
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
  }, [outState, llm.config, teacherModel, goldMaxTasks, allReady]);

  const onRunRejection = useCallback(async () => {
    if (!allReady || outState.kind !== 'restored') return;
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
        outputDir: outState.outputDir,
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
  }, [outState, llm.config, studentModelId, judgeModel, rolloutsPerTask, rejMaxTasks, allReady]);

  // ---- Dataset picker (reads from sandbox) ----

  const onSelectDataset = useCallback(async (path: string) => {
    setTgDataset(path);
    setProbeError(null);
    if (!path || !sandboxReady) return;
    setProbing(true);
    try {
      const probe = await probeDataset(path);
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
  }, [sandboxReady]);

  const onGenerateTasks = useCallback(async () => {
    if (!allReady || outState.kind !== 'restored') return;
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
        outputDir: outState.outputDir,
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
  }, [outState, llm.config, teacherModel, tgFlavor, tgDataset, tgSchema, tgCount, allReady]);

  return (
    <section style={{ padding: '2rem', fontFamily: "'IBM Plex Sans', sans-serif", maxWidth: 860 }}>
      <h1 style={{ margin: '0 0 0.25rem' }}>haw data generation</h1>
      <p style={{ color: '#666', margin: '0 0 2rem' }}>
        Developer-only mode for building Gemma fine-tuning datasets. Runs the
        production agent loop against a local sandbox (input datasets) and
        writes JSONL into a separate output directory.
      </p>

      <Card title="Sandbox (input — read-only)">
        <p style={{ margin: '0 0 0.75rem', color: '#444' }}>
          Holds your input datasets. Same plumbing as the live agent —
          the directory you pick here is the directory the agent's{' '}
          <code>LoadData</code> resolves against. Picking here also
          updates the sandbox the live agent uses.
        </p>
        {!hasFsAccess && (
          <p style={errStyle}>File System Access API is not available. Use Chrome, Edge, Brave, or Arc.</p>
        )}
        {sandbox.status === 'unset' && (
          <button style={btnStyle} onClick={sandbox.chooseDirectory}>Pick sandbox…</button>
        )}
        {sandbox.status === 'permission-denied' && (
          <>
            <p style={errStyle}>Permission denied for <code>{sandbox.directoryName}</code>.</p>
            <button style={btnStyle} onClick={sandbox.reAuthorise}>Re-grant permission</button>
          </>
        )}
        {sandbox.status === 'permitted' && (
          <>
            <p style={{ margin: '0 0 0.5rem' }}>
              Active: <code>{sandbox.directoryName}</code> ·{' '}
              {sandbox.files.length} file{sandbox.files.length === 1 ? '' : 's'} ({datasets.length} loadable)
            </p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button style={btnStyle} onClick={sandbox.chooseDirectory}>Switch…</button>
              <button style={{ ...btnStyle, ...btnSecondary }} onClick={sandbox.refreshFiles}>↻ Refresh</button>
              <button style={{ ...btnStyle, ...btnSecondary }} onClick={sandbox.clearDirectory}>Forget</button>
            </div>
          </>
        )}
      </Card>

      <Card title="Output directory (read-write)">
        <p style={{ margin: '0 0 0.75rem', color: '#444' }}>
          Holds generated artefacts: <code>tasks/*.jsonl</code>,{' '}
          <code>trajectories.jsonl</code>, <code>dpo.jsonl</code>.
          Separate from the sandbox so input data stays read-only.
        </p>
        {!hasFsAccess && (
          <p style={errStyle}>File System Access API is not available.</p>
        )}
        {hasFsAccess && outState.kind === 'idle' && (
          <button style={btnStyle} onClick={onPickOutput}>Pick output directory…</button>
        )}
        {hasFsAccess && outState.kind === 'restored' && (
          <>
            <p style={{ margin: '0 0 0.5rem' }}>
              Active: <code>{outState.outputDir.name}</code>
            </p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button style={btnStyle} onClick={onPickOutput}>Switch…</button>
              <button style={{ ...btnStyle, ...btnSecondary }} onClick={onReauthOutput}>Re-grant permission</button>
              <button style={{ ...btnStyle, ...btnSecondary }} onClick={onClearOutput}>Forget</button>
            </div>
          </>
        )}
        {outState.kind === 'error' && <p style={errStyle}>{outState.message}</p>}
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
          <div style={{ marginTop: '0.25rem' }}>
            <ModelPickerCell
              endpointUrl={OPENROUTER_ENDPOINT}
              providerLabel="Teacher"
              value={teacherModel}
              apiKey={openrouterKey}
              entry={orModelsEntry}
              onCommit={setTeacherModel}
              onRefresh={refreshOrModels}
              disabled={!hasOpenrouterKey}
            />
          </div>
        </label>
      </Card>

      <Card title="Test trajectory (one shot)">
        <label style={labelStyle}>
          User prompt
          <textarea
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            placeholder="e.g. Load datasets/iris/Iris.csv and tell me the median petal length."
            style={{ ...inputStyle, minHeight: 80, fontFamily: 'inherit' }}
          />
        </label>
        <div style={{ marginTop: '0.75rem' }}>
          <button
            style={btnStyle}
            onClick={onRun}
            disabled={runState.kind === 'running' || !allReady}
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
              appended to <code>trajectories.jsonl</code>
            </p>
            <TurnList turns={runState.record.turns} />
          </>
        )}
        {runState.kind === 'error' && <p style={errStyle}>{runState.message}</p>}
      </Card>

      <Card title="Generate task corpus (teacher → tasks/*.jsonl)">
        <p style={{ margin: '0 0 0.75rem', color: '#444' }}>
          Have the teacher generate a batch of user prompts for a sandbox dataset.
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
          Dataset (from sandbox)
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
            <select
              value={tgDataset}
              onChange={(e) => onSelectDataset(e.target.value)}
              style={{ ...inputStyle, flex: 1, marginTop: 0 }}
              disabled={!sandboxReady || datasets.length === 0}
            >
              <option value="">{!sandboxReady ? 'Pick a sandbox first' : datasets.length === 0 ? 'No data files in sandbox' : '— pick a file —'}</option>
              {datasets.map((d) => (
                <option key={d.path} value={d.path}>
                  {d.path} ({formatBytes(d.size)})
                </option>
              ))}
            </select>
            <button
              type="button"
              style={{ ...btnStyle, ...btnSecondary }}
              onClick={sandbox.refreshFiles}
              disabled={!sandboxReady}
              title="Re-read the sandbox directory"
            >
              ↻
            </button>
          </div>
        </label>
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
            disabled={tgState.kind === 'running' || !allReady}
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
          Reads <code>tasks/*.jsonl</code> from the output directory, runs
          the teacher loop on each task, appends to{' '}
          <code>trajectories.jsonl</code>. Skips taskIds already
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
            disabled={goldState.kind === 'running' || !allReady}
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
            <div style={{ marginTop: '0.25rem' }}>
              <ModelPickerCell
                endpointUrl={OPENROUTER_ENDPOINT}
                providerLabel="Judge"
                value={judgeModel}
                apiKey={openrouterKey}
                entry={orModelsEntry}
                onCommit={setJudgeModel}
                onRefresh={refreshOrModels}
                disabled={!hasOpenrouterKey}
              />
            </div>
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
            disabled={rejState.kind === 'running' || !allReady}
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
