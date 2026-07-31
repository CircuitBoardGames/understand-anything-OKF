/**
 * Export an analysed knowledge graph as an Open Knowledge Format (OKF) v0.1 bundle.
 *
 * NO SHEBANG, deliberately. This file is both a CLI and an imported module, and a `#!` line in a
 * module that gets imported is a parse error under vitest on a CRLF checkout — Windows checks out
 * CRLF by default, so `import`ing it dies with `SyntaxError: Invalid or unexpected token` while
 * Linux passes. The sibling scripts keep their shebangs because they are only ever spawned;
 * `plugin-root.mjs`, the other imported module here, has none for the same reason. Every documented
 * invocation is `node export-okf.mjs …`, so the shebang bought nothing. `test_export_okf.test.mjs`
 * asserts the CRLF import keeps working.
 *
 * The graph this plugin produces is JSON: rich, but readable only by this plugin's own dashboard
 * and by whatever agent is holding the file. OKF is the portable form of the same information —
 * a directory of Markdown files whose YAML frontmatter carries `type` — so a graph exported here
 * can be read by any OKF consumer, diffed in review, opened in an editor, and committed alongside
 * the code it describes without the reader needing this plugin at all.
 *
 * The one hard conformance rule (spec §9) is that every non-reserved `.md` file has parseable
 * frontmatter with a non-empty `type`. Every node already carries a `type` (`file`, `function`,
 * `class`, `document`), so the mapping is direct and total; `index.md` and `log.md` are reserved
 * names and exempt.
 *
 * The export is DETERMINISTIC: nodes are emitted in sorted order and the only timestamp written is
 * the graph's own `project.analyzedAt`. Re-exporting an unchanged graph therefore produces
 * byte-identical output, so a diff means the graph moved — not that the exporter ran again.
 *
 * Usage:
 *   node export-okf.mjs [--graph <knowledge-graph.json>] [--out <dir>] [--force]
 *
 * Defaults: the graph is looked up in `.understand-anything/` then `.ua/` under the cwd, and the
 * bundle is written to `<that dir>/okf`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const UA_DIR_CANDIDATES = ['.understand-anything', '.ua'];
const GRAPH_FILENAME = 'knowledge-graph.json';

/** Frontmatter fields OKF §4.1 recommends, in the order the spec lists them. */
const RECOMMENDED_ORDER = ['type', 'title', 'description', 'resource', 'tags', 'timestamp'];

/** A filesystem- and link-safe slug. Never empty: an all-punctuation name becomes `unnamed`. */
export function slugify(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'unnamed';
}

/** Collapse a summary to one line — YAML scalars must not carry raw newlines. */
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** A double-quoted YAML scalar. Escapes only what the quoted form makes special. */
function quote(value) {
  return `"${oneLine(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function frontmatter(fields) {
  const lines = [];
  for (const key of RECOMMENDED_ORDER) {
    const value = fields[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}: [${value.map((v) => oneLine(v)).join(', ')}]`);
    } else {
      lines.push(`${key}: ${quote(value)}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

/**
 * Which bundle directory a node belongs in.
 *
 * `layers[].nodeIds` generally lists file-level nodes only, so a function or class inherits the
 * layer of the file it lives in — otherwise every symbol lands in `unassigned` and the layer
 * structure, which is the most useful thing the graph knows, is lost in the export.
 */
function layerIndex(graph) {
  const byNode = new Map();
  const dirs = new Map();
  for (const layer of graph.layers ?? []) {
    const dir = slugify(String(layer.id ?? '').replace(/^layer:/, '') || layer.name);
    dirs.set(dir, { name: layer.name ?? dir, description: layer.description ?? '' });
    for (const id of layer.nodeIds ?? []) byNode.set(id, dir);
  }
  const byFilePath = new Map();
  for (const node of graph.nodes ?? []) {
    const dir = byNode.get(node.id);
    if (dir && node.filePath) byFilePath.set(node.filePath, dir);
  }
  return {
    dirs,
    dirFor(node) {
      return byNode.get(node.id) ?? byFilePath.get(node.filePath) ?? 'unassigned';
    },
  };
}

function edgesByNode(graph) {
  const out = new Map();
  for (const edge of graph.edges ?? []) {
    for (const [end, other, direction] of [
      [edge.source, edge.target, 'out'],
      [edge.target, edge.source, 'in'],
    ]) {
      if (!out.has(end)) out.set(end, []);
      out.get(end).push({ type: edge.type ?? 'related', other, direction });
    }
  }
  return out;
}

function conceptBody(node, paths, edges, selfPath) {
  const parts = [];
  parts.push(`# Overview\n\n${node.summary?.trim() || 'No summary was recorded for this node.'}\n`);

  const source = [];
  if (node.filePath) {
    const range = Array.isArray(node.lineRange) ? ` (lines ${node.lineRange[0]}–${node.lineRange[1]})` : '';
    source.push(`- Source: \`${node.filePath}\`${range}`);
  }
  if (node.complexity) source.push(`- Complexity: ${node.complexity}`);
  if (source.length) parts.push(`# Source\n\n${source.join('\n')}\n`);

  if (node.languageNotes?.trim()) parts.push(`# Language notes\n\n${node.languageNotes.trim()}\n`);

  const grouped = new Map();
  for (const edge of edges ?? []) {
    const target = paths.get(edge.other);
    // A dangling edge is rendered as plain text rather than a broken link: §5.3 requires
    // consumers to tolerate unresolvable links, but there is no reason to write one.
    const label = target
      ? `[${target.title}](${relative(dirname(selfPath), target.path) || target.path})`
      : `\`${edge.other}\``;
    const heading = edge.direction === 'out' ? edge.type : `${edge.type} (inbound)`;
    if (!grouped.has(heading)) grouped.set(heading, new Set());
    grouped.get(heading).add(label);
  }
  if (grouped.size) {
    const rendered = [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([heading, links]) => `- **${heading}**: ${[...links].sort().join(', ')}`);
    parts.push(`# Relationships\n\n${rendered.join('\n')}\n`);
  }
  return parts.join('\n');
}

/**
 * Build the whole bundle in memory.
 *
 * Returns a Map of bundle-relative path → file contents, so the shape can be asserted without
 * touching a filesystem, and so writing is a separate, dumb step.
 */
export function buildBundle(graph) {
  const project = graph.project ?? {};
  const timestamp = project.analyzedAt ?? '';
  const layers = layerIndex(graph);
  const edges = edgesByNode(graph);
  const nodes = [...(graph.nodes ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // Assign paths first: a concept's Relationships section links to other concepts, so every
  // path has to be known before any body is rendered.
  const paths = new Map();
  const used = new Set();
  for (const node of nodes) {
    const dir = layers.dirFor(node);
    const base = slugify(node.name || node.id);
    let candidate = `${dir}/${base}.md`;
    for (let n = 2; used.has(candidate); n += 1) candidate = `${dir}/${base}-${n}.md`;
    used.add(candidate);
    paths.set(node.id, { path: candidate, title: node.name || node.id, dir, type: node.type });
  }

  const files = new Map();
  for (const node of nodes) {
    const self = paths.get(node.id);
    files.set(
      self.path,
      frontmatter({
        type: node.type || 'node', // §9 is a hard rule; a typeless node still gets a type.
        title: node.name || node.id,
        description: node.summary,
        resource: node.filePath,
        tags: node.tags,
        timestamp,
      }) + '\n' + conceptBody(node, paths, edges.get(node.id), self.path),
    );
  }

  // Per-directory index.md — a reserved name (§6): a plain listing, no frontmatter.
  const byDir = new Map();
  for (const { path, title, dir, type } of paths.values()) {
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push({ path, title, type });
  }
  for (const [dir, entries] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const meta = layers.dirs.get(dir);
    const lines = entries
      .sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path))
      .map((e) => `* [${e.title}](${e.path.slice(dir.length + 1)}) — ${e.type}`);
    files.set(
      `${dir}/index.md`,
      `# ${meta?.name ?? 'Unassigned'}\n\n${meta?.description ? `${meta.description}\n\n` : ''}${lines.join('\n')}\n`,
    );
  }

  const tour = [...(graph.tour ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (tour.length) {
    const steps = tour.map((step) => {
      // `nodeIds` is a list: a tour step routinely covers several nodes at once.
      const links = (step.nodeIds ?? [])
        .map((id) => paths.get(id))
        .filter(Boolean)
        .map((target) => `[${target.title}](${target.path})`);
      const trailer = links.length ? ` — see ${links.join(', ')}` : '';
      return `${step.order ?? '-'}. **${step.title}** — ${oneLine(step.description)}${trailer}`;
    });
    files.set(
      'tour.md',
      frontmatter({
        type: 'tour',
        title: `${project.name ?? 'Project'} guided tour`,
        description: `Ordered walkthrough of ${project.name ?? 'the project'} in ${tour.length} steps.`,
        tags: ['tour', 'onboarding'],
        timestamp,
      }) + `\n# Tour\n\n${steps.join('\n')}\n`,
    );
  }

  // Bundle-root index.md — reserved, and the one file allowed frontmatter carrying okf_version.
  const dirLinks = [...byDir.keys()]
    .sort()
    .map((dir) => `* [${layers.dirs.get(dir)?.name ?? 'Unassigned'}](${dir}/index.md)`);
  files.set(
    'index.md',
    `---\nokf_version: "0.1"\n---\n\n# ${project.name ?? 'Knowledge graph'}\n\n` +
      `${project.description ? `${project.description}\n\n` : ''}` +
      `Exported from an [Understand Anything](https://github.com/CircuitBoardGames/understand-anything-OKF) ` +
      `knowledge graph${project.gitCommitHash ? ` at commit \`${project.gitCommitHash}\`` : ''}` +
      `${timestamp ? `, analysed ${timestamp}` : ''}.\n\n` +
      `# Layers\n\n${dirLinks.join('\n')}\n` +
      (files.has('tour.md') ? `\n# Guided tour\n\n* [Start the tour](tour.md)\n` : ''),
  );

  return files;
}

/** Write a built bundle. Refuses to write into a directory that is not already one of ours. */
export function writeBundle(files, outDir, { force = false } = {}) {
  if (existsSync(outDir) && readdirSync(outDir).length > 0 && !existsSync(join(outDir, 'index.md')) && !force) {
    throw new Error(
      `${outDir} is not empty and does not look like an exported bundle (no index.md). ` +
        `Pass --force to write into it anyway.`,
    );
  }
  for (const [rel, contents] of files) {
    const target = join(outDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return files.size;
}

function findGraph(cwd) {
  for (const dir of UA_DIR_CANDIDATES) {
    const candidate = resolve(cwd, dir, GRAPH_FILENAME);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--graph') args.graph = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--force') args.force = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const graphPath = args.graph ? resolve(args.graph) : findGraph(process.cwd());
  if (!graphPath || !existsSync(graphPath)) {
    console.error(
      `No knowledge graph found. Looked for ${UA_DIR_CANDIDATES.map((d) => `${d}/${GRAPH_FILENAME}`).join(' and ')} ` +
        `under ${process.cwd()}. Run the analysis first, or pass --graph <path>.`,
    );
    return 1;
  }
  const outDir = resolve(args.out ?? join(dirname(graphPath), 'okf'));
  const files = buildBundle(JSON.parse(readFileSync(graphPath, 'utf-8')));
  const count = writeBundle(files, outDir, { force: args.force });
  console.log(`Wrote ${count} file(s) to ${outDir}`);
  console.log(`Validate: uv run okf_validate.py ${outDir} --strict`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
