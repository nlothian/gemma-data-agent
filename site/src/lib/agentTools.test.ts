import { describe, it, expect } from 'vitest';
import {
  AGENT_TOOLS,
  AGENT_SYSTEM_PROMPT,
  buildAgentTools,
  buildAgentSystemPrompt,
  buildListInputsEntries,
  parseLoadDataInput,
  runAgentTool,
  toInputVirtualPath,
  type AgentPromptFeatures,
} from './agentTools';
import { setMode } from './toolDebugger';
import type { RegisteredInputMeta } from './duckdb';

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

  it('WriteLines schema treats `from`/`to` as optional (omit both to create or overwrite the whole file)', () => {
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

describe('CallSkill', () => {
  it('is registered regardless of feature flags', () => {
    const allOff = buildAgentTools({
      dataLoading: false,
      runSql: false,
      runPython: false,
      runReact: false,
      runSubAgent: false,
      fileTools: false,
    });
    expect(allOff.map((t) => t.name)).toContain('CallSkill');
    expect(buildAgentTools({}).map((t) => t.name)).toContain('CallSkill');
  });

  it('declares skill as an enum of the five valid values', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'CallSkill');
    expect(tool).toBeDefined();
    const params = tool!.parameters as {
      properties: { skill: { enum: string[] } };
      required: string[];
    };
    expect(params.required).toEqual(['skill']);
    expect(params.properties.skill.enum).toEqual([
      'react',
      'matplotlib',
      'python-pass-data',
      'sql',
      'data-loading',
    ]);
  });

  it('returns the markdown for each known skill', async () => {
    const react = await runAgentTool('CallSkill', { skill: 'react' });
    expect(typeof react).toBe('string');
    expect(react as string).toContain('recharts');

    const matplotlib = await runAgentTool('CallSkill', { skill: 'matplotlib' });
    expect(typeof matplotlib).toBe('string');
    expect(matplotlib as string).toContain('plt.show()');

    const passData = await runAgentTool('CallSkill', {
      skill: 'python-pass-data',
    });
    expect(typeof passData).toBe('string');
    expect(passData as string).toContain('arrow_tables');

    const sql = await runAgentTool('CallSkill', { skill: 'sql' });
    expect(typeof sql).toBe('string');
    expect(sql as string).toContain('_last_sql_result');

    const dataLoading = await runAgentTool('CallSkill', {
      skill: 'data-loading',
    });
    expect(typeof dataLoading).toBe('string');
    expect(dataLoading as string).toContain('ListInputs');
  });

  it('returns a ToolError for an unknown skill name', async () => {
    const res = (await runAgentTool('CallSkill', { skill: 'bogus' })) as {
      error?: string;
    };
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/Unknown skill/);
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

  // ── Recoverable artifacts: normalised, no pathError ──────────────────────

  it('a truly bare path resolves and is never gated (documents that bare works)', () => {
    const r = parseLoadDataInput({ url: 'test.csv', table_name: 't' });
    expect(r.url).toBe('test.csv');
    expect(r.isRemote).toBe(false);
    expect(r.pathError).toBeUndefined();
  });

  it('strips a single leading `./` (the form a model naturally emits)', () => {
    const r = parseLoadDataInput({ url: './test.csv', table_name: 't' });
    expect(r.url).toBe('test.csv');
    expect(r.pathError).toBeUndefined();
  });

  it('strips repeated leading `./././`', () => {
    const r = parseLoadDataInput({ url: './././reports/sales.csv', table_name: 's' });
    expect(r.url).toBe('reports/sales.csv');
    expect(r.pathError).toBeUndefined();
  });

  it('strips `/input/` then a leading `./` together', () => {
    const r = parseLoadDataInput({ url: '/input/./reports/sales.csv', table_name: 's' });
    expect(r.url).toBe('reports/sales.csv');
    expect(r.pathError).toBeUndefined();
  });

  it('the verbatim ListInputs sourcePath resolves to the bare path, ungated', () => {
    const r = parseLoadDataInput({
      url: '/input/reports/sales.csv',
      table_name: 's',
    });
    expect(r.url).toBe('reports/sales.csv');
    expect(r.pathError).toBeUndefined();
  });

  // ── Unrecoverable manglings: directive pathError, NOT the raw browser msg ─

  const directive = /Don't construct sandbox paths.*sourcePath.*ListInputs.*verbatim/s;

  it('`../x` → directive pathError pointing at the ListInputs sourcePath', () => {
    const r = parseLoadDataInput({ url: '../secrets.csv', table_name: 's' });
    expect(r.pathError).toBeDefined();
    expect(r.pathError!).toMatch(directive);
    // not the cryptic FS Access message
    expect(r.pathError!).not.toMatch(/getDirectoryHandle|Name is not allowed/);
  });

  it('interior `..` segment (`a/../b`) → directive pathError', () => {
    expect(parseLoadDataInput({ url: 'a/../b.csv', table_name: 'b' }).pathError)
      .toMatch(directive);
  });

  it('interior `.` segment (`foo/./bar`) → directive pathError', () => {
    expect(parseLoadDataInput({ url: 'foo/./bar.csv', table_name: 'b' }).pathError)
      .toMatch(directive);
  });

  it('a bare `..` → directive pathError', () => {
    expect(parseLoadDataInput({ url: '..', table_name: 'b' }).pathError)
      .toMatch(directive);
  });

  it('`/input/../x` (escape via the virtual root) → directive pathError', () => {
    const r = parseLoadDataInput({ url: '/input/../etc/passwd', table_name: 'x' });
    expect(r.pathError).toMatch(directive);
  });

  it('a remote URL containing `..` is NOT gated (only sandbox paths are)', () => {
    const r = parseLoadDataInput({
      url: 'https://example.com/a/../b.csv',
      table_name: 'b',
    });
    expect(r.isRemote).toBe(true);
    expect(r.pathError).toBeUndefined();
  });

  it('LoadData dispatch short-circuits a dot-segment path with the directive error (never reaches the FS API)', async () => {
    // The tool gate defaults to 'paused'; drive it to 'running' so dispatch
    // doesn't block waiting for a Step/Play that never comes in tests.
    setMode('running');
    try {
      const res = (await runAgentTool('LoadData', {
        url: '../secrets.csv',
        table_name: 's',
      })) as { error?: string };
      expect(res.error).toBeDefined();
      expect(res.error!).toMatch(directive);
      expect(res.error!).not.toMatch(/Name is not allowed|No sandbox directory/);
    } finally {
      setMode('paused');
    }
  });
});

describe('toInputVirtualPath', () => {
  it('roots a bare sandbox-relative path under /input', () => {
    expect(toInputVirtualPath('reports/sales.csv')).toBe('/input/reports/sales.csv');
    expect(toInputVirtualPath('sales.csv')).toBe('/input/sales.csv');
  });

  it('round-trips with parseLoadDataInput — the `/input/` form ListInputs emits resolves back to the bare path', () => {
    const sourcePath = toInputVirtualPath('reports/sales.csv');
    expect(sourcePath).toBe('/input/reports/sales.csv');
    const parsed = parseLoadDataInput({ url: sourcePath, table_name: 'sales' });
    expect(parsed.url).toBe('reports/sales.csv');
    expect(parsed.isRemote).toBe(false);
  });
});

describe('buildListInputsEntries', () => {
  const meta = (over: Partial<RegisteredInputMeta>): RegisteredInputMeta => ({
    name: 'x',
    encoding: 'arrow-ipc',
    format: 'csv',
    source: 'sandbox',
    byteLength: 10,
    publishedAt: 0,
    ...over,
  });

  it('roots a loaded sandbox entry under /input but leaves url/sql/python verbatim', () => {
    const entries = buildListInputsEntries(
      [
        meta({ name: 'sales', source: 'sandbox', sourcePath: 'reports/sales.csv' }),
        meta({ name: 'remote', source: 'url', sourcePath: 'https://example.com/d.csv' }),
        meta({ name: 'q', source: 'sql', sourcePath: 'SELECT 1' }),
        meta({ name: 'py', source: 'python' }), // no sourcePath at all
      ],
      [],
    );
    const byName = Object.fromEntries(
      entries.map((e) => [e.loaded ? e.name : e.sourcePath, e]),
    );
    expect((byName.sales as { sourcePath: string }).sourcePath).toBe(
      '/input/reports/sales.csv',
    );
    // A URL must never be prefixed — `/input/https://…` would be a bug.
    expect((byName.remote as { sourcePath: string }).sourcePath).toBe(
      'https://example.com/d.csv',
    );
    expect((byName.q as { sourcePath: string }).sourcePath).toBe('SELECT 1');
    expect((byName.py as { sourcePath?: string }).sourcePath).toBeUndefined();
    expect(entries.every((e) => e.loaded)).toBe(true);
  });

  it('prefixes unloaded sandbox files with /input', () => {
    const entries = buildListInputsEntries(
      [],
      [
        { relativePath: 'a.csv', ext: 'csv', sizeBytes: 1 },
        { relativePath: 'nested/b.parquet', ext: 'parquet', sizeBytes: 2 },
      ],
    );
    expect(entries).toEqual([
      {
        loaded: false,
        source: 'sandbox',
        sourcePath: '/input/a.csv',
        format: 'csv',
        byteLength: 1,
      },
      {
        loaded: false,
        source: 'sandbox',
        sourcePath: '/input/nested/b.parquet',
        format: 'parquet',
        byteLength: 2,
      },
    ]);
  });

  it('does not re-list a sandbox file already in the registry (dedup is bare-path, not /input-prefixed)', () => {
    const entries = buildListInputsEntries(
      [meta({ name: 'sales', source: 'sandbox', sourcePath: 'reports/sales.csv' })],
      [
        { relativePath: 'reports/sales.csv', ext: 'csv', sizeBytes: 1 }, // dup → dropped
        { relativePath: 'other.csv', ext: 'csv', sizeBytes: 2 },
      ],
    );
    expect(entries).toHaveLength(2);
    const loaded = entries.find((e) => e.loaded);
    const unloaded = entries.find((e) => !e.loaded);
    expect(loaded?.sourcePath).toBe('/input/reports/sales.csv');
    expect(unloaded?.sourcePath).toBe('/input/other.csv');
  });
});

// ─── Feature-gated CallSkill ──────────────────────────────────────────────

const ALL: AgentPromptFeatures = {
  dataLoading: true,
  runSql: true,
  runPython: true,
  runReact: true,
  runSubAgent: true,
  fileTools: true,
};
const NONE: AgentPromptFeatures = {
  dataLoading: false,
  runSql: false,
  runPython: false,
  runReact: false,
  runSubAgent: false,
  fileTools: false,
};
const feat = (over: Partial<AgentPromptFeatures>): AgentPromptFeatures => ({
  ...NONE,
  ...over,
});

function callSkillParams(features: AgentPromptFeatures) {
  const tool = buildAgentTools(features).find((t) => t.name === 'CallSkill');
  expect(tool, 'CallSkill must always be built').toBeDefined();
  return tool!.parameters as {
    type: string;
    properties: { skill: { type: string; enum?: string[] } };
    required: string[];
    additionalProperties: boolean;
  };
}
const callSkillEnum = (features: AgentPromptFeatures): string[] =>
  callSkillParams(features).properties.skill.enum ?? [];

// The canonical skill → gating-feature map, asserted black-box through the
// public builders so a mis-wired SKILLS entry is caught here.
const SKILLS_MAP: ReadonlyArray<
  [skill: string, feature: keyof AgentPromptFeatures, required: boolean]
> = [
  ['react', 'runReact', false],
  ['matplotlib', 'runPython', false],
  ['python-pass-data', 'runPython', false],
  ['sql', 'runSql', true],
  ['data-loading', 'dataLoading', true],
];

describe('CallSkill — module integrity / cross-validation', () => {
  it('importing agentTools did not throw (frontmatter parsed + cross-checked)', () => {
    // If any skill .md had malformed frontmatter, or its name/feature
    // disagreed with the SKILLS array, the module would have thrown at load
    // and this whole file would fail to import. Reaching here proves it.
    expect(AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('exposes exactly the five known skills, in declared order', () => {
    expect(callSkillEnum(ALL)).toEqual([
      'react',
      'matplotlib',
      'python-pass-data',
      'sql',
      'data-loading',
    ]);
  });

  it.each(SKILLS_MAP)(
    'skill %s is gated solely by feature %s',
    (skill, feature) => {
      expect(callSkillEnum(feat({ [feature]: true }))).toContain(skill);
      expect(callSkillEnum(feat({ [feature]: false }))).not.toContain(skill);
    },
  );

  it('runPython unlocks BOTH matplotlib and python-pass-data', () => {
    const e = callSkillEnum(feat({ runPython: true }));
    expect(e).toContain('matplotlib');
    expect(e).toContain('python-pass-data');
    expect(e).not.toContain('sql');
    expect(e).not.toContain('react');
    expect(callSkillEnum(feat({ runPython: false }))).not.toContain(
      'matplotlib',
    );
  });

  it('marks sql and data-loading as REQUIRED in the system prompt, others not', () => {
    const p = buildAgentSystemPrompt(ALL);
    for (const [skill, , required] of SKILLS_MAP) {
      const line = p
        .split('\n')
        .find((l) => l.includes(`CallSkill('${skill}')`));
      expect(line, `bullet for ${skill}`).toBeDefined();
      expect(
        /\*\*REQUIRED\*\*/.test(line!),
        `${skill} REQUIRED marker`,
      ).toBe(required);
    }
  });
});

describe('CallSkill — feature-aware tool spec', () => {
  it('DEFAULT (no arg) build exposes all five skills', () => {
    const enumDefault = (
      buildAgentTools().find((t) => t.name === 'CallSkill')!
        .parameters as { properties: { skill: { enum?: string[] } } }
    ).properties.skill.enum;
    expect(enumDefault).toEqual([
      'react',
      'matplotlib',
      'python-pass-data',
      'sql',
      'data-loading',
    ]);
  });

  it('a single enabled feature yields only that skill', () => {
    expect(callSkillEnum(feat({ runSql: true }))).toEqual(['sql']);
    expect(callSkillEnum(feat({ runReact: true }))).toEqual(['react']);
    expect(callSkillEnum(feat({ dataLoading: true }))).toEqual([
      'data-loading',
    ]);
  });

  it('keeps SKILLS order when a subset is enabled', () => {
    expect(callSkillEnum(feat({ runReact: true, runSql: true }))).toEqual([
      'react',
      'sql',
    ]);
  });

  it('description lists only enabled skills', () => {
    const desc = buildAgentTools(feat({ runSql: true })).find(
      (t) => t.name === 'CallSkill',
    )!.description;
    expect(desc).toContain("'sql'");
    expect(desc).toContain('REQUIRED');
    expect(desc).not.toContain("'react'");
    expect(desc).not.toContain("'matplotlib'");
  });

  it('with NO skill-relevant feature, CallSkill is still present but offers nothing', () => {
    const tools = buildAgentTools(NONE);
    expect(tools.map((t) => t.name)).toContain('CallSkill');
    const params = callSkillParams(NONE);
    // enum keyword omitted entirely (some providers reject enum: [])
    expect(params.properties.skill).not.toHaveProperty('enum');
    // schema still structurally valid
    expect(params.type).toBe('object');
    expect(params.required).toEqual(['skill']);
    expect(params.additionalProperties).toBe(false);
    const desc = tools.find((t) => t.name === 'CallSkill')!.description;
    expect(desc).toContain('No reference cards are available');
  });

  it('runSubAgent / fileTools alone unlock no skills', () => {
    expect(callSkillEnum(feat({ runSubAgent: true }))).toEqual([]);
    expect(callSkillEnum(feat({ fileTools: true }))).toEqual([]);
  });

  it('AGENT_TOOLS (static, no-features) still carries the full skill enum', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'CallSkill')!;
    const params = tool.parameters as {
      properties: { skill: { enum: string[] } };
    };
    expect(params.properties.skill.enum).toEqual([
      'react',
      'matplotlib',
      'python-pass-data',
      'sql',
      'data-loading',
    ]);
    // and is still only {name, description, parameters}
    expect(Object.keys(tool).sort()).toEqual([
      'description',
      'name',
      'parameters',
    ]);
  });
});

describe('CallSkill — feature-aware system prompt section', () => {
  it('base.md no longer hardcodes the reference-card list', () => {
    // The section must come from generation, not the static base prompt:
    // with NO skills enabled it must be entirely absent.
    const none = buildAgentSystemPrompt(NONE);
    expect(none).not.toContain('On-demand reference cards');
    expect(none).not.toContain("CallSkill('");
  });

  it('all-off prompt has no dangling header or intro', () => {
    const none = buildAgentSystemPrompt(NONE);
    expect(none).not.toMatch(/On-demand reference cards/);
    expect(none).not.toMatch(/fetch them on demand/);
    expect(none).not.toMatch(/Read-only and free to call any time/);
  });

  it('DEFAULT prompt contains the section, header and all five bullets', () => {
    const p = buildAgentSystemPrompt(ALL);
    expect(p).toContain('## On-demand reference cards (`CallSkill`)');
    expect(p).toContain('fetch them on demand');
    for (const [skill] of SKILLS_MAP) {
      expect(p, `bullet for ${skill}`).toContain(`CallSkill('${skill}')`);
    }
  });

  it.each(SKILLS_MAP)(
    'system prompt includes the %s bullet iff %s is enabled',
    (skill, feature) => {
      expect(buildAgentSystemPrompt(feat({ [feature]: true }))).toContain(
        `CallSkill('${skill}')`,
      );
      expect(
        buildAgentSystemPrompt(feat({ [feature]: false })),
      ).not.toContain(`CallSkill('${skill}')`);
    },
  );

  it('renders the canonical bullet wording (trigger + Returns payload)', () => {
    const p = buildAgentSystemPrompt(feat({ runSql: true }));
    expect(p).toContain(
      "- `CallSkill('sql')` — **REQUIRED** before your first `RunSQL` " +
        'call. Returns the WriteLines+RunSQL workflow, the ' +
        '`_last_sql_result` / `arrow_inputs` bridge, sample-row ' +
        'truncation, and `register_as` semantics.',
    );
    const r = buildAgentSystemPrompt(feat({ runReact: true }));
    expect(r).toContain(
      "- `CallSkill('react')` — before importing any React-sandbox library",
    );
    expect(r).toContain('Returns import specifiers and mount patterns.');
  });

  it('lists the bullets only — skill bodies are NOT inlined', () => {
    const p = buildAgentSystemPrompt(ALL);
    // These tokens live ONLY in a skill card body (not in any tool prompt
    // fragment and not in a frontmatter blurb): the body is fetched on
    // demand via CallSkill and must not bloat the system prompt.
    expect(p).not.toContain('exception_type'); // SqlSkill body only
    expect(p).not.toContain('BufferOutputStream'); // PythonPassData body only
  });

  it('AGENT_SYSTEM_PROMPT equals the DEFAULT_FEATURES build (module constant is deterministic & all-on)', () => {
    expect(AGENT_SYSTEM_PROMPT).toBe(buildAgentSystemPrompt());
    expect(AGENT_SYSTEM_PROMPT).toContain('## On-demand reference cards');
    expect(buildAgentSystemPrompt()).toBe(buildAgentSystemPrompt());
  });

  it('sub-agent feature subset (runSubAgent:false) keeps all five skills', () => {
    const sub = buildAgentSystemPrompt({ ...ALL, runSubAgent: false });
    for (const [skill] of SKILLS_MAP) {
      expect(sub).toContain(`CallSkill('${skill}')`);
    }
  });

  it('the tool spec and the prompt section agree on the enabled set', () => {
    for (const f of [
      feat({ runSql: true }),
      feat({ runPython: true }),
      feat({ runReact: true, dataLoading: true }),
      ALL,
    ]) {
      const enumNames = callSkillEnum(f);
      const prompt = buildAgentSystemPrompt(f);
      for (const [skill] of SKILLS_MAP) {
        expect(prompt.includes(`CallSkill('${skill}')`)).toBe(
          enumNames.includes(skill),
        );
      }
    }
  });
});

describe('CallSkill — run() returns frontmatter-stripped bodies', () => {
  it.each([
    ['react', 'recharts'],
    ['matplotlib', 'plt.show()'],
    ['python-pass-data', 'arrow_tables'],
    ['sql', '_last_sql_result'],
    ['data-loading', 'ListInputs'],
  ])('%s body is returned without its frontmatter block', async (skill, token) => {
    const md = (await runAgentTool('CallSkill', { skill })) as string;
    expect(typeof md).toBe('string');
    expect(md).toContain(token);
    // frontmatter delimiters / keys must be gone
    expect(md.startsWith('---')).toBe(false);
    expect(md).not.toContain('requires-feature:');
    expect(md).not.toContain('blurb:');
    // title line preserved as the first line
    expect(md.split('\n')[0].startsWith('# ')).toBe(true);
  });

  it('run() is existence-only — a real skill resolves regardless of features (gating is at the spec layer)', async () => {
    // Decision: the dispatcher has no per-path feature handle; gating the
    // model happens via the enum. run() must still return a known card.
    const md = (await runAgentTool('CallSkill', { skill: 'python-pass-data' })) as
      | string
      | { error: string };
    expect(typeof md).toBe('string');
  });

  it('unknown skill → ToolError listing the valid skills (derived, no drift)', async () => {
    const res = (await runAgentTool('CallSkill', { skill: 'nope' })) as {
      error?: string;
    };
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/Unknown skill/);
    expect(res.error).toContain("'sql'");
    expect(res.error).toContain("'data-loading'");
  });

  it('empty / non-string skill is rejected as unknown, not crashed', async () => {
    const res = (await runAgentTool('CallSkill', { skill: 123 })) as {
      error?: string;
    };
    expect(res.error).toMatch(/Unknown skill/);
  });
});
