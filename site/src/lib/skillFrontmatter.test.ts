import { describe, it, expect } from 'vitest';
import {
  parseSkillMarkdown,
  SkillFrontmatterError,
  FEATURE_KEYS,
} from './skillFrontmatter';

const VALID = [
  '---',
  'name: sql',
  'requires-feature: runSql',
  'required: true',
  'when: "your first `RunSQL` call"',
  'blurb: "the workflow and bridge"',
  '---',
  '# RunSQL reference card',
  '',
  'Body paragraph.',
].join('\n');

describe('parseSkillMarkdown — valid input', () => {
  it('parses every field with correct types', () => {
    const { meta } = parseSkillMarkdown(VALID, 'SqlSkill.md');
    expect(meta).toEqual({
      name: 'sql',
      requiresFeature: 'runSql',
      required: true,
      when: 'your first `RunSQL` call',
      blurb: 'the workflow and bridge',
    });
  });

  it('strips the frontmatter from the body and trims leading blanks', () => {
    const { body } = parseSkillMarkdown(VALID, 'SqlSkill.md');
    expect(body.startsWith('# RunSQL reference card')).toBe(true);
    expect(body).not.toContain('requires-feature');
    expect(body).not.toContain('---');
    expect(body).toContain('Body paragraph.');
  });

  it('parses required: false as a boolean', () => {
    const src = VALID.replace('required: true', 'required: false');
    expect(parseSkillMarkdown(src, 'x').meta.required).toBe(false);
  });

  it('accepts bare-scalar strings for name and requires-feature', () => {
    const { meta } = parseSkillMarkdown(VALID, 'x');
    expect(typeof meta.name).toBe('string');
    expect(meta.name).toBe('sql');
    expect(meta.requiresFeature).toBe('runSql');
  });

  it('keeps backticks and colons inside double-quoted values', () => {
    const src = VALID.replace(
      'when: "your first `RunSQL` call"',
      'when: "use `LoadData`: read/load workflow"',
    );
    expect(parseSkillMarkdown(src, 'x').meta.when).toBe(
      'use `LoadData`: read/load workflow',
    );
  });

  it('honours \\" and \\\\ escapes in quoted values', () => {
    const src = VALID.replace(
      'blurb: "the workflow and bridge"',
      'blurb: "a \\"quoted\\" path \\\\ here"',
    );
    expect(parseSkillMarkdown(src, 'x').meta.blurb).toBe(
      'a "quoted" path \\ here',
    );
  });

  it('skips blank lines and # comment lines inside the block', () => {
    const src = [
      '---',
      '# leading comment',
      'name: sql',
      '',
      'requires-feature: runSql',
      '   # indented comment',
      'required: true',
      'when: "w"',
      'blurb: "b"',
      '---',
      '# Title',
    ].join('\n');
    expect(parseSkillMarkdown(src, 'x').meta.name).toBe('sql');
  });

  it('strips a leading UTF-8 BOM', () => {
    const { meta } = parseSkillMarkdown('﻿' + VALID, 'x');
    expect(meta.name).toBe('sql');
  });

  it('tolerates CRLF line endings', () => {
    const src = VALID.replace(/\n/g, '\r\n');
    const { meta, body } = parseSkillMarkdown(src, 'x');
    expect(meta.name).toBe('sql');
    expect(body.startsWith('# RunSQL reference card')).toBe(true);
    expect(body).not.toContain('\r');
  });

  it('does not mis-parse a later "---" in the body as frontmatter', () => {
    const src = [
      '---',
      'name: sql',
      'requires-feature: runSql',
      'required: true',
      'when: "w"',
      'blurb: "b"',
      '---',
      '# Title',
      '',
      'Some prose.',
      '',
      '---',
      '',
      'A horizontal rule above; this line must survive.',
      '',
      '```',
      '--- not frontmatter ---',
      '```',
    ].join('\n');
    const { body } = parseSkillMarkdown(src, 'x');
    expect(body).toContain('A horizontal rule above; this line must survive.');
    expect(body).toContain('--- not frontmatter ---');
    // The body's own "---" rule is preserved.
    expect(body.match(/^---$/gm)?.length).toBe(1);
  });

  it('is deterministic — same input yields deep-equal output', () => {
    expect(parseSkillMarkdown(VALID, 'x')).toEqual(
      parseSkillMarkdown(VALID, 'x'),
    );
  });
});

describe('parseSkillMarkdown — malformed input throws SkillFrontmatterError', () => {
  const expectThrows = (src: string, re: RegExp) => {
    expect(() => parseSkillMarkdown(src, 'Card.md')).toThrowError(
      SkillFrontmatterError,
    );
    expect(() => parseSkillMarkdown(src, 'Card.md')).toThrowError(re);
  };

  it('no leading "---"', () => {
    expectThrows('# Title\n\nbody', /missing frontmatter/);
  });

  it('unterminated block (no closing "---")', () => {
    expectThrows('---\nname: sql\n# Title', /unterminated frontmatter/);
  });

  it.each(['name', 'requires-feature', 'required', 'when', 'blurb'])(
    'missing required key: %s',
    (key) => {
      const src = VALID.split('\n')
        .filter((l) => !l.startsWith(`${key}:`))
        .join('\n');
      expectThrows(src, new RegExp(`missing required frontmatter key.*${key}`));
    },
  );

  it('unknown frontmatter key', () => {
    const src = VALID.replace('name: sql', 'name: sql\nbogus: x');
    expectThrows(src, /unknown frontmatter key.*bogus/);
  });

  it('a requires_feature underscore typo is rejected (loud, not silent)', () => {
    const src = VALID.replace(
      'requires-feature: runSql',
      'requires_feature: runSql\nrequires-feature: runSql',
    );
    expectThrows(src, /malformed frontmatter line/);
  });

  it('duplicate key', () => {
    const src = VALID.replace('name: sql', 'name: sql\nname: dupe');
    expectThrows(src, /duplicate frontmatter key.*name/);
  });

  it('unknown requires-feature value lists the valid keys', () => {
    const src = VALID.replace('requires-feature: runSql', 'requires-feature: runBogus');
    expectThrows(src, /requires-feature.*runBogus.*runSql/s);
  });

  it('array / sequence value', () => {
    const src = VALID.replace('blurb: "the workflow and bridge"', 'blurb: [a, b]');
    expectThrows(src, /unsupported value syntax/);
  });

  it('YAML sequence dash line', () => {
    const src = VALID.replace(
      'blurb: "the workflow and bridge"',
      'blurb:\n  - one\n  - two',
    );
    expectThrows(src, /(empty value|malformed frontmatter line|unsupported value syntax)/);
  });

  it('empty value', () => {
    const src = VALID.replace('name: sql', 'name:');
    expectThrows(src, /empty value for "name"/);
  });

  it('required not a boolean', () => {
    const src = VALID.replace('required: true', 'required: yes');
    expectThrows(src, /"required" must be true or false/);
  });

  it('malformed line without a colon', () => {
    const src = VALID.replace('name: sql', 'name: sql\njust some words');
    expectThrows(src, /malformed frontmatter line/);
  });

  it('unterminated quoted string', () => {
    const src = VALID.replace('when: "your first `RunSQL` call"', 'when: "oops');
    expectThrows(src, /unterminated quoted string for "when"/);
  });

  it('unsupported escape in quoted string', () => {
    const src = VALID.replace('blurb: "the workflow and bridge"', 'blurb: "bad \\n esc"');
    expectThrows(src, /unsupported escape.*blurb/);
  });

  it('content after closing quote', () => {
    const src = VALID.replace('blurb: "the workflow and bridge"', 'blurb: "ok" trailing');
    expectThrows(src, /unexpected content after closing quote for "blurb"/);
  });

  it('embeds the source label in the error message', () => {
    expect(() => parseSkillMarkdown('no fence', 'MySkill.md')).toThrowError(
      /^MySkill\.md:/,
    );
  });
});

describe('FEATURE_KEYS', () => {
  it('matches the AgentPromptFeatures key set exactly', () => {
    expect([...FEATURE_KEYS].sort()).toEqual(
      [
        'dataLoading',
        'fileTools',
        'runPython',
        'runReact',
        'runSql',
        'runSubAgent',
      ].sort(),
    );
  });
});
