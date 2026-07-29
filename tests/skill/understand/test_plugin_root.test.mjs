import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePluginRoot } from '../../../understand-anything-plugin/skills/understand/plugin-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(__dirname, '../../../understand-anything-plugin');
const SKILL_DIR = join(PLUGIN, 'skills/understand');

const temps = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'ua-plugin-root-'));
  temps.push(d);
  return d;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
  delete process.env.PLUGIN_ROOT;
});

describe('resolvePluginRoot', () => {
  it('finds the plugin root from a script sitting inside the plugin', () => {
    expect(resolvePluginRoot(SKILL_DIR)).toBe(PLUGIN);
  });

  it('refuses to return a plausible-but-wrong directory for a copied-out script', () => {
    // Claude Code copies skills into <repo>/.claude/skills/<name>/. Two dirs up is then
    // `<repo>/.claude`, which is a real directory — the old `resolve(__dirname, '../..')`
    // returned it silently and the failure surfaced later as a module-resolution error.
    const repo = tmp();
    const copied = join(repo, '.claude/skills/understand');
    mkdirSync(copied, { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'some-host-app' }));

    expect(() => resolvePluginRoot(copied)).toThrow(/Could not locate the understand-anything plugin root/);
    // The error must name what it tried, so the fix is obvious from the message alone.
    expect(() => resolvePluginRoot(copied)).toThrow(/\.claude/);
  });

  it('honours PLUGIN_ROOT when the script has been copied out', () => {
    const repo = tmp();
    const copied = join(repo, '.claude/skills/understand');
    mkdirSync(copied, { recursive: true });
    process.env.PLUGIN_ROOT = PLUGIN;
    expect(resolvePluginRoot(copied)).toBe(PLUGIN);
  });

  it('ignores a PLUGIN_ROOT that is not a plugin checkout instead of trusting it', () => {
    const bogus = tmp();
    writeFileSync(join(bogus, 'package.json'), JSON.stringify({ name: 'not-the-plugin' }));
    process.env.PLUGIN_ROOT = bogus;
    expect(resolvePluginRoot(SKILL_DIR)).toBe(PLUGIN);
  });

  // Class guard, not a one-off. compute-batches.mjs carried the identical defect spelled
  // `resolve(dirname(__filename), '../..')` and was missed by a grep for `__dirname` — so
  // assert on the OUTCOME (every root-resolver goes through resolvePluginRoot) rather than
  // on one spelling of the bug. Any new script reintroducing the guess fails here.
  it('leaves no script in skills/understand resolving the plugin root by a relative guess', () => {
    const offenders = [];
    for (const name of readdirSync(SKILL_DIR).filter(f => f.endsWith('.mjs'))) {
      if (name === 'plugin-root.mjs') continue;          // owns the fallback candidate itself
      const src = readFileSync(join(SKILL_DIR, name), 'utf-8');
      // Strip block/line comments so prose about the bug doesn't read as the bug.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (!/createRequire/.test(code)) continue;          // only scripts that need a plugin root
      const guesses = code.match(/resolve\([^;]*?['"]\.\.\/\.\.['"]\s*\)/g) || [];
      if (guesses.length) offenders.push(`${name}: ${guesses.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('walks up to the checkout when the skill dir is nested deeper than expected', () => {
    const root = tmp();
    cpSync(join(PLUGIN, 'package.json'), join(root, 'package.json'));
    mkdirSync(join(root, 'packages/core'), { recursive: true });
    const deep = join(root, 'a/b/c/skills/understand');
    mkdirSync(deep, { recursive: true });
    expect(resolvePluginRoot(deep)).toBe(root);
  });
});
