import { describe, it, expect } from 'vitest';
import {
  AGENT_TOOLS,
  buildAgentTools,
  buildAgentSystemPrompt,
  parseLoadDataInput,
  runAgentTool,
  type AgentPromptFeatures,
} from './agentTools';

describe('agentTools registry', () => {
  it('every feature-gated tool contributes a system-prompt fragment', () => {
    const base = buildAgentSystemPrompt({});
    const keys: (keyof AgentPromptFeatures)[] = [
      'dataLoading',
      'runSql',
      'runPython',
      'runReact',
      'runSubAgent',
      'fileTools',
    ];
    for (const key of keys) {
      const withOne = buildAgentSystemPrompt({ [key]: true });
      expect(withOne.length).toBeGreaterThan(base.length);
    }
  });

  it('buildAgentTools omits RunSubAgent when runSubAgent is false', () => {
    const tools = buildAgentTools({
      dataLoading: true,
      runSql: true,
      runPython: true,
      runReact: true,
      runSubAgent: false,
      fileTools: true,
    });
    expect(tools.find((t) => t.name === 'RunSubAgent')).toBeUndefined();
    // ListInputs has no featureKey — always included.
    expect(tools.map((t) => t.name)).toContain('ListInputs');
  });

  it('buildAgentTools omits ListFiles/ReadLines/WriteLines when fileTools is false', () => {
    const tools = buildAgentTools({
      dataLoading: true,
      runSql: true,
      runPython: true,
      runReact: true,
      runSubAgent: true,
      fileTools: false,
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('ListFiles');
    expect(names).not.toContain('ReadLines');
    expect(names).not.toContain('WriteLines');
  });

  it('AGENT_TOOLS contains the three file tools', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).toContain('ListFiles');
    expect(names).toContain('ReadLines');
    expect(names).toContain('WriteLines');
  });

  it('WriteLines schema treats `from`/`to` as optional (omit both to create a new file)', () => {
    const byName = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
    const tool = byName.get('WriteLines');
    expect(tool).toBeDefined();
    const params = tool!.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.required).toEqual(['path', 'content']);
    expect(params.properties).toHaveProperty('from');
    expect(params.properties).toHaveProperty('to');
  });

  it('RunPython/RunSQL/RunReact schemas require `path` and no longer accept `code`/`sql`', () => {
    const byName = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
    for (const name of ['RunPython', 'RunSQL', 'RunReact'] as const) {
      const tool = byName.get(name);
      expect(tool, `${name} should be registered`).toBeDefined();
      const params = tool!.parameters as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(params.required).toContain('path');
      expect(params.properties).toHaveProperty('path');
      expect(params.properties).not.toHaveProperty('code');
      expect(params.properties).not.toHaveProperty('sql');
    }
  });

  it('runAgentTool returns { error } for an unknown tool name', async () => {
    const res = await runAgentTool('NopeNotATool', {});
    expect(res).toEqual({ error: 'Unknown tool: NopeNotATool' });
  });

  it('AGENT_TOOLS entries only expose {name, description, parameters}', () => {
    for (const tool of AGENT_TOOLS) {
      const keys = Object.keys(tool).sort();
      expect(keys).toEqual(['description', 'name', 'parameters']);
    }
  });

  it('RunSubAgent with empty prompt returns ToolError before reaching imports', async () => {
    // If the empty-prompt guard regressed, dispatch would fall through to the
    // dynamic imports of `./subAgents/*` and either fail with a different
    // error string or hit `getSubAgentContext()` (returning the unavailable
    // error). Either case fails this assertion.
    const res = await runAgentTool('RunSubAgent', { prompt: '   ' });
    expect(res).toEqual({ error: 'RunSubAgent requires a non-empty `prompt`.' });
  });
});

describe('parseLoadDataInput', () => {
  it('passes bare sandbox paths through unchanged', () => {
    const r = parseLoadDataInput({ url: 'pollution.csv', table_name: 'p' });
    expect(r).toEqual({
      url: 'pollution.csv',
      tableName: 'p',
      format: undefined,
      isRemote: false,
    });
  });

  it('strips the `/input/` virtual-root prefix that ListFiles/ReadLines use', () => {
    const r = parseLoadDataInput({
      url: '/input/reports/sales.csv',
      table_name: 'sales',
    });
    expect(r.url).toBe('reports/sales.csv');
    expect(r.isRemote).toBe(false);
  });

  it('treats `/input` alone as an empty path (so downstream surfaces the real error)', () => {
    const r = parseLoadDataInput({ url: '/input', table_name: 'x' });
    expect(r.url).toBe('');
    expect(r.isRemote).toBe(false);
  });

  it('only strips `/input` at the segment boundary — `/inputfoo` is preserved', () => {
    const r = parseLoadDataInput({ url: '/inputfoo.csv', table_name: 'x' });
    expect(r.url).toBe('/inputfoo.csv');
  });

  it('strips the `sandbox:` scheme', () => {
    const r = parseLoadDataInput({ url: 'sandbox:pollution.csv', table_name: 'p' });
    expect(r.url).toBe('pollution.csv');
    expect(r.isRemote).toBe(false);
  });

  it('strips the `file://` scheme', () => {
    const r = parseLoadDataInput({ url: 'file://pollution.csv', table_name: 'p' });
    expect(r.url).toBe('pollution.csv');
    expect(r.isRemote).toBe(false);
  });

  it('detects remote URLs via `://`', () => {
    const r = parseLoadDataInput({
      url: 'https://example.com/data.csv',
      table_name: 'd',
    });
    expect(r.url).toBe('https://example.com/data.csv');
    expect(r.isRemote).toBe(true);
  });

  it('accepts `format` only for csv/json/parquet, drops anything else', () => {
    expect(parseLoadDataInput({ url: 'a.csv', table_name: 'a', format: 'csv' }).format)
      .toBe('csv');
    expect(parseLoadDataInput({ url: 'a.json', table_name: 'a', format: 'json' }).format)
      .toBe('json');
    expect(parseLoadDataInput({ url: 'a.pq', table_name: 'a', format: 'parquet' }).format)
      .toBe('parquet');
    // xlsx is a valid sandbox format but is *not* one of the duckdb-format
    // overrides — coerced to undefined and resolved by extension instead.
    expect(parseLoadDataInput({ url: 'a.xlsx', table_name: 'a', format: 'xlsx' }).format)
      .toBeUndefined();
    expect(parseLoadDataInput({ url: 'a.csv', table_name: 'a', format: 'garbage' }).format)
      .toBeUndefined();
  });

  it('returns empty strings for non-string `url` / `table_name` rather than crashing', () => {
    const r = parseLoadDataInput({ url: 42, table_name: null });
    expect(r).toEqual({ url: '', tableName: '', format: undefined, isRemote: false });
  });
});
