import { describe, it, expect } from 'vitest';
import {
  AGENT_TOOLS,
  buildAgentTools,
  buildAgentSystemPrompt,
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
