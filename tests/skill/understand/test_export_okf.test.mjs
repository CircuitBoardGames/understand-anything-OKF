import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const MODULE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../understand-anything-plugin/skills/understand/export-okf.mjs',
);

import {
  buildBundle,
  writeBundle,
  slugify,
} from '../../../understand-anything-plugin/skills/understand/export-okf.mjs';

const temps = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'ua-okf-'));
  temps.push(d);
  return d;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

/** Reserved OKF filenames (§6/§7) are exempt from the frontmatter rule. */
const RESERVED = new Set(['index.md', 'log.md']);
const isReserved = (rel) => RESERVED.has(rel.split('/').pop());

/**
 * The §9 conformance rule, implemented independently of the exporter: parseable frontmatter with a
 * non-empty `type`. Returns the list of offending paths so a failure names them.
 */
function nonConformant(files) {
  const bad = [];
  for (const [rel, contents] of files) {
    if (isReserved(rel)) continue;
    const match = /^---\n([\s\S]*?)\n---\n/.exec(contents);
    if (!match) {
      bad.push(`${rel}: no frontmatter block`);
      continue;
    }
    const type = /^type:\s*"?([^"\n]*)"?\s*$/m.exec(match[1]);
    if (!type || !type[1].trim()) bad.push(`${rel}: missing or empty type`);
  }
  return bad;
}

const GRAPH = {
  version: '1.0.0',
  project: {
    name: 'Fixture',
    description: 'A two-layer fixture project.',
    analyzedAt: '2026-07-27T09:13:51Z',
    gitCommitHash: 'abc1234',
  },
  nodes: [
    {
      id: 'file:src/app.ts',
      type: 'file',
      name: 'app.ts',
      filePath: 'src/app.ts',
      summary: 'Entry point.',
      tags: ['entry-point'],
    },
    {
      id: 'function:src/app.ts:boot',
      type: 'function',
      name: 'boot',
      filePath: 'src/app.ts',
      lineRange: [4, 9],
      summary: 'Starts the app.',
    },
    {
      id: 'file:docs/readme.md',
      type: 'document',
      name: 'readme.md',
      filePath: 'docs/readme.md',
      summary: 'Docs.',
    },
  ],
  edges: [
    { source: 'file:src/app.ts', target: 'function:src/app.ts:boot', type: 'contains' },
    { source: 'file:src/app.ts', target: 'file:missing/gone.ts', type: 'imports' },
  ],
  layers: [
    { id: 'layer:runtime', name: 'Runtime', description: 'The app.', nodeIds: ['file:src/app.ts'] },
    { id: 'layer:docs', name: 'Docs', description: 'Prose.', nodeIds: ['file:docs/readme.md'] },
  ],
  tour: [{ order: 1, title: 'Start here', description: 'Read the entry point.', nodeIds: ['file:src/app.ts'] }],
};

describe('buildBundle — OKF §9 conformance', () => {
  it('emits a bundle where every non-reserved file has a non-empty type', () => {
    expect(nonConformant(buildBundle(GRAPH))).toEqual([]);
  });

  it('FAILS the same check on a bundle with a typeless concept', () => {
    // Without this pair the assertion above proves nothing: a check that cannot fail is not a
    // check. Strip the field the rule is about and the same function must report it.
    const files = buildBundle(GRAPH);
    const [rel, contents] = [...files].find(([r]) => !isReserved(r));
    files.set(rel, contents.replace(/^type:.*\n/m, ''));
    expect(nonConformant(files)).toEqual([`${rel}: missing or empty type`]);
  });

  it('still emits a type for a node whose own type is missing', () => {
    // §9 is a hard rule, so a degraded graph must not produce a non-conformant bundle.
    const graph = { ...GRAPH, nodes: [{ id: 'x:1', name: 'mystery', summary: 'No type recorded.' }] };
    expect(nonConformant(buildBundle(graph))).toEqual([]);
  });
});

describe('buildBundle — structure', () => {
  it('gives a symbol the layer of the file it lives in, not "unassigned"', () => {
    // layers[].nodeIds lists file-level nodes only; without inheritance every function lands
    // outside the layer structure, which is the most useful thing the graph knows.
    const files = buildBundle(GRAPH);
    expect([...files.keys()]).toContain('runtime/boot.md');
    expect([...files.keys()].some((k) => k.startsWith('unassigned/'))).toBe(false);
  });

  it('writes a reserved index.md per directory plus a root index carrying okf_version', () => {
    const files = buildBundle(GRAPH);
    expect(files.get('index.md')).toMatch(/^---\nokf_version: "0\.1"\n---/);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['runtime/index.md', 'docs/index.md']));
  });

  it('links only to files the bundle actually contains', () => {
    // Assert on what the output SAYS, not merely that it was produced: every relative link a
    // concept names must resolve inside the bundle. A dangling edge is rendered as plain text.
    const files = buildBundle(GRAPH);
    const missing = [];
    const windowsSeparators = [];
    for (const [rel, contents] of files) {
      for (const [, target] of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        if (/^[a-z]+:\/\//.test(target)) continue; // external URL
        // Bundle paths are virtual, so resolve them with `posix` on every host. Using the
        // platform `path` here made this assertion pass on Linux and fail on Windows — where
        // the emitted links really were broken, because the exporter had the same bug.
        if (target.includes('\\')) windowsSeparators.push(`${rel} → ${target}`);
        const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
        if (!files.has(resolved)) missing.push(`${rel} → ${target}`);
      }
    }
    expect(missing).toEqual([]);
    // A Markdown link with a backslash is broken everywhere, so this must hold on every host.
    expect(windowsSeparators).toEqual([]);
  });

  it('renders an edge to a node outside the graph without a broken link', () => {
    const app = buildBundle(GRAPH).get('runtime/app-ts.md');
    expect(app).toContain('`file:missing/gone.ts`');
    expect(app).not.toContain('](file:missing/gone.ts)');
  });

  it('is deterministic — the same graph builds byte-identical output', () => {
    const a = buildBundle(GRAPH);
    const b = buildBundle(JSON.parse(JSON.stringify(GRAPH)));
    expect([...b]).toEqual([...a]);
  });

  it('disambiguates two nodes that slug to the same filename', () => {
    const graph = {
      ...GRAPH,
      layers: [],
      nodes: [
        { id: 'function:a.ts:run', type: 'function', name: 'run', filePath: 'a.ts', summary: 'A.' },
        { id: 'function:b.ts:run', type: 'function', name: 'run', filePath: 'b.ts', summary: 'B.' },
      ],
      tour: [],
      edges: [],
    };
    const keys = [...buildBundle(graph).keys()].filter((k) => !isReserved(k));
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual(expect.arrayContaining(['unassigned/run.md', 'unassigned/run-2.md']));
  });
});

describe('portability', () => {
  it('imports cleanly from a CRLF checkout', async () => {
    // Windows checks out CRLF by default. A `#!` line in a module that is IMPORTED (rather than
    // spawned) is a parse error under vitest once the file is CRLF — `SyntaxError: Invalid or
    // unexpected token`, on Windows only, while Linux stays green. That is exactly how this file
    // first failed CI. Reproduce the condition here so a re-added shebang fails on every platform.
    const src = readFileSync(MODULE_PATH, 'utf-8');
    expect(src.startsWith('#!')).toBe(false);

    const crlf = join(tmp(), 'crlf-copy.mjs');
    writeFileSync(crlf, src.replace(/\r?\n/g, '\r\n'));
    const mod = await import(pathToFileURL(crlf).href);
    expect(typeof mod.buildBundle).toBe('function');
  });
});

describe('CLI entry point', () => {
  function runCli(scriptPath, outDir) {
    const graphPath = join(dirname(outDir), 'graph.json');
    writeFileSync(graphPath, JSON.stringify(GRAPH));
    return spawnSync(process.execPath, [scriptPath, '--graph', graphPath, '--out', outDir], {
      encoding: 'utf-8',
    });
  }

  it('runs when invoked directly', () => {
    const out = join(tmp(), 'okf');
    const r = runCli(MODULE_PATH, out);
    expect(r.status).toBe(0);
    expect(existsSync(join(out, 'index.md'))).toBe(true);
  });

  it('runs when invoked THROUGH A SYMLINK', (ctx) => {
    // The gap that shipped: a host repo symlinks this script into its own skills directory, which
    // is the documented way to consume it. Node resolves symlinks for `import.meta.url` but not for
    // `process.argv[1]`, so the old main-check never matched and the CLI became a SILENT no-op —
    // exit 0, no output, nothing written. Every earlier test and the end-to-end smoke run used the
    // real path, so none of them could see it.
    const dir = tmp();
    const link = join(dir, 'linked-export.mjs');
    try {
      symlinkSync(MODULE_PATH, link);
    } catch {
      // Windows refuses symlinks without developer mode or elevation. Skip LOUDLY rather than
      // returning green: a silent pass here would hide the very failure mode this test exists for.
      ctx.skip();
      return;
    }
    const out = join(dir, 'okf');
    const r = runCli(link, out);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Wrote \d+ file\(s\)/);
    expect(existsSync(join(out, 'index.md'))).toBe(true);
  });
});

describe('slugify', () => {
  it('never returns an empty filename', () => {
    expect(slugify('///')).toBe('unnamed');
    expect(slugify('')).toBe('unnamed');
    expect(slugify('.graphifyignore')).toBe('graphifyignore');
  });
});

describe('writeBundle', () => {
  it('writes every file and creates the directories', () => {
    const out = join(tmp(), 'okf');
    const files = buildBundle(GRAPH);
    expect(writeBundle(files, out)).toBe(files.size);
    expect(existsSync(join(out, 'runtime/boot.md'))).toBe(true);
    expect(readFileSync(join(out, 'index.md'), 'utf-8')).toContain('okf_version');
  });

  it('refuses a non-empty directory that is not already a bundle, unless forced', () => {
    // The output directory is user-chosen; clobbering someone's notes folder is not recoverable.
    const out = join(tmp(), 'not-a-bundle');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'important.md'), 'do not clobber');

    expect(() => writeBundle(buildBundle(GRAPH), out)).toThrow(/does not look like an exported bundle/);
    expect(readFileSync(join(out, 'important.md'), 'utf-8')).toBe('do not clobber');

    expect(() => writeBundle(buildBundle(GRAPH), out, { force: true })).not.toThrow();
    expect(existsSync(join(out, 'index.md'))).toBe(true);
  });

  it('re-exports over its own previous output without --force', () => {
    const out = join(tmp(), 'okf');
    writeBundle(buildBundle(GRAPH), out);
    expect(() => writeBundle(buildBundle(GRAPH), out)).not.toThrow();
  });
});
