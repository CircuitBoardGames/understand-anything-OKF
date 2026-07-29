#!/usr/bin/env node
/**
 * generate-ignore.mjs
 *
 * Writes a starter `.understandignore` into the project's data directory
 * (`.ua/`, or legacy `.understand-anything/` when that directory already
 * exists — see core's resolveUaDir) by delegating to
 * `generateStarterIgnoreFile` in `@understand-anything/core`. Invoked from
 * SKILL.md Phase 0.5; replaces the inline `node -e "…"` block that previously
 * duplicated the generator logic.
 *
 * Usage:
 *   node generate-ignore.mjs <projectRoot>
 *
 * Behaviour:
 *   - Exits 0 with a stderr notice if the target file already exists.
 *   - Creates the resolved data dir (`.ua/` or legacy
 *     `.understand-anything/`) if missing.
 *   - Emits a one-line stderr summary on success.
 *
 * Mirrors the @understand-anything/core resolution dance used by
 * scan-project.mjs: workspace-linked package first, plugin-cache dist fallback.
 *
 * Plugin root resolution: see ./plugin-root.mjs — $PLUGIN_ROOT first, then checked candidates,
 * never a bare `resolve(__dirname, '../..')` (which resolves to the wrong directory, silently,
 * when `skills/understand/` has been copied out of the plugin checkout).
 */

import { createRequire } from 'node:module';
import { resolvePluginRoot } from './plugin-root.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pluginRoot = resolvePluginRoot(__dirname);
const require = createRequire(resolve(pluginRoot, 'package.json'));

let core;
try {
  core = await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
} catch {
  core = await import(pathToFileURL(resolve(pluginRoot, 'packages/core/dist/index.js')).href);
}

const { generateStarterIgnoreFile, resolveUaDir } = core;

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const outDir = resolveUaDir(projectRoot);
const outPath = join(outDir, '.understandignore');

if (existsSync(outPath)) {
  console.error(`generate-ignore: ${outPath} already exists — skipping`);
  process.exit(0);
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, generateStarterIgnoreFile(projectRoot));
console.error(`generate-ignore: wrote ${outPath}`);
