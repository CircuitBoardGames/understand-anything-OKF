/**
 * Resolve the plugin checkout root from a script that may not be sitting inside it.
 *
 * These scripts are routinely COPIED out of the plugin — into `.claude/skills/understand/` by
 * Claude Code, or into a host repo's own skills directory by a vendoring convention. A copied
 * script is byte-identical to the original and still fails, because `resolve(__dirname, '../..')`
 * means the plugin root from `<plugin>/skills/understand/` and something else entirely from
 * `.claude/skills/understand/` (there, it is `.claude/`). The failure is silent in the worst way:
 * the path RESOLVES, `createRequire` is handed a package.json that does not exist, and the error
 * surfaces later as a confusing module-resolution failure rather than "I am not where I think".
 *
 * So: candidates in preference order, each CHECKED before it is accepted, and a thrown error that
 * names everything tried when none of them holds. A wrong-but-plausible directory is never
 * returned. This is the same shape as `$PLUGIN_ROOT`'s existing existsSync gate in
 * generate-ignore.mjs, generalised so every script in this directory shares one implementation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** A directory is the plugin root if it has the plugin's own package.json. */
function isPluginRoot(dir) {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return false;
  try {
    const { name, workspaces } = JSON.parse(readFileSync(pkg, 'utf-8'));
    // The plugin root is the workspace root that owns @understand-anything/*.
    return name === 'understand-anything' || name?.startsWith('@understand-anything/') ||
           existsSync(join(dir, 'packages', 'core'));
  } catch {
    return false;                       // unparseable package.json is not a root
  }
}

/**
 * @param {string} scriptDir  the calling script's own directory (dirname(fileURLToPath(import.meta.url)))
 * @returns {string} absolute path to the plugin root
 * @throws {Error} listing every candidate tried, when none is a plugin checkout
 */
export function resolvePluginRoot(scriptDir) {
  const tried = [];
  const candidates = [];

  if (process.env.PLUGIN_ROOT) candidates.push(process.env.PLUGIN_ROOT);
  candidates.push(resolve(scriptDir, '../..'));          // the in-plugin layout

  // Walk up from the script: covers a copy nested at an unexpected depth inside a checkout.
  for (let dir = scriptDir, prev = null; dir !== prev; prev = dir, dir = dirname(dir)) {
    candidates.push(dir);
  }

  for (const dir of candidates) {
    if (!dir || tried.includes(dir)) continue;
    tried.push(dir);
    if (isPluginRoot(dir)) return dir;
  }

  throw new Error(
    `Could not locate the understand-anything plugin root from ${scriptDir}.\n` +
    `This usually means this script was copied outside the plugin checkout — set PLUGIN_ROOT ` +
    `to the checkout, or run it from inside the plugin.\nTried:\n  ${tried.join('\n  ')}`
  );
}
