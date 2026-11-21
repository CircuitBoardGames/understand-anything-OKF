### Incremental update path

`prepare-incremental.mjs` has already refreshed the complete file inventory and `importMap`, written the exact analyzer list, and pruned changed/deleted paths from the old graph into `batch-existing.json`.

1. If `filesToReanalyze` is non-empty, dispatch file-analyzer only for the batches from the incremental `batches.json`, using the same prompt template as the full path. Include `previousSymbols`: the function/class/method node checklist for those files from `incremental-symbol-baseline.json` (IDs, names, types, paths, line ranges, and class containment). Existing symbols that still exist must survive significance filtering; regenerate their semantics from current source. Never add `deletedFiles`, `cosmeticFiles`, `ignoredFiles`, or `generatedArtifactFiles` to a prompt.
2. If `filesToReanalyze` is empty, dispatch no agent and create no new batch file.
3. Run the merge script in both cases:

   ```bash
   python "<SKILL_DIR>/merge-batch-graphs.py" "$PROJECT_ROOT"
   ```

The merge combines `batch-existing.json` with any fresh batch output. Its import recovery reads the already-refreshed `scan-result.json`, so added and removed imports are reflected during this same run. Require a successful exit as well as `assembled-graph.json` before continuing. A failed merge can deliberately leave an incomplete candidate for diagnosis.

**Symbol-loss gate and one targeted retry:** Merge invokes `validate-incremental-symbols.mjs`. Read `incremental-symbol-report.json`: it reports per-file before/after counts and missing node IDs/names even when counts stay equal. Missing functions, classes, and methods (including `classes[].methods`) are classified against base/current source with the same strict parser. Only confirmed source deletions are allowed; still-present and unknown symbols block publication.

Before dropping dangling endpoints, merge records normalized edge candidates from fresh batches in `incremental-edge-candidates.json`, bound to the base/head commits. Every successful validation reconciles their source and target IDs against accepted symbol replacements, including first-pass updates that need no retry. Retry also preserves these alongside surviving current edges, so an edge to the initially omitted symbol can be restored after repair. Edges from `batch-existing.json` are not collected as fresh evidence.

Candidate endpoints use the current analysis's node and ownership descriptors before any baseline alias is applied: an ID reused by a different current symbol must keep its current meaning. During repair, incoming edges are deferred outside the ordinary retained batch until those original HEAD descriptors can be matched against replacement nodes, so temporary ID reuse cannot create a false edge during merge.

The strict parser emits versioned, scoped symbol evidence with separate declaration-coverage gaps and runtime effects. Each entry records its kind, scope, name, source location, and reason. File, named-class, local, and unknown scopes are distinct; local scopes never act as wildcard uncertainty. Unknown names are explicit; a known declaration or installer on `B` cannot preserve a missing `A` symbol. Static keys retain their exact names, including the distinction between Ruby readers and writers. Dynamic keys, unresolved receiver bindings, installer aliases, and arbitrary evaluation only block identities compatible with that uncertainty. The report includes the matching evidence for investigation.

Source identity is `(file path, symbol kind, owner, name)`. Same-line functions/methods use AST scope instead of inferred line containment. Shadowed/reassigned receiver names are unconfirmed; ordinary reads, strings, and parameters are not declarations. If an old ID is reused for a different current identity, repair must supply distinct descriptors. Unsupported parsing or declaration coverage, empty extraction, ambiguous identities, and stale evidence formats remain blocking. Declaration ownership, reference bindings, and expression value regions all use one lexical scope index.

The decision rules, limits, and cross-product test matrix are documented in `docs/incremental/symbol-loss-validation.md` in the repository. This validation uses structural source identities and recognized declaration/installer syntax; it does not execute programs or perform whole-program metaprogramming/type analysis.

Go receiver methods, Rust inherent impl methods, and C++ out-of-class definitions retain explicit type ownership and their own source ranges. Their duplicate entries in `classes[].methods` are reconciled without assuming the method body is inside the type declaration. Free functions with the same name stay distinct; unresolved receivers and Rust trait impl identities remain `unknown`. Receiver changes also affect structural fingerprints when the type declaration is in another file.

When the report has `unresolvedFiles`, prepare exactly one repair:

```bash
node "<SKILL_DIR>/prepare-symbol-retry.mjs" "$PROJECT_ROOT"
```

This helper revalidates the candidate, records attempt 1/1 for the base/head commits, removes the affected files' new nodes and outgoing edges, clears old numeric batch shards, and preserves other merged results in `batch-0.json`. Current inbound edges from other files remain candidates until merge reconciles their targets against the replacement nodes; candidates with missing targets are dropped. Dispatch only `batches[]` from `incremental-symbol-retry.json`, using each batch's `files`, `batchIndex`, `batchImportData`, `neighborMap`, `previousSymbols`, and `missingSymbols`. Use the normal file-analyzer prompt and output names. The repair must reanalyze each affected file completely, not just append missing nodes. Then rerun merge. Do not rerun prepare to obtain another retry; the attempt remains used for those commits.

If repair preparation, the repair dispatch, or the second merge fails, **STOP** and retain diagnostics. Do not publish or advance `knowledge-graph.json`, `fingerprints.json`, or `meta.json`. Never concatenate old nodes or old semantic edges into the candidate to satisfy the gate. Other merge failures without eligible unresolved files stop immediately. On success, continue to the applicable architecture/tour phases.

Parser limitation: automatic deletion requires both a deterministic parser and a declaration-coverage adapter. Current adapters cover JavaScript/JSX, TypeScript/TSX, Ruby, Python, Go, Rust, C++, and shell (the bash grammar; a `.zsh` file that does not parse as bash stays `unknown`); other grammars remain conservative even if parsing succeeds. Languages without a deterministic structural parser (including `.ps1` and `.bat`) cannot have missing symbols automatically confirmed as deleted. Such omissions remain `unknown`, even for genuine deletions, and stop publication pending manual investigation or parser support. Supplemental LLM source inspection and regex guesses are not deletion evidence. Callables without explicit class containment require source identity verification even when their IDs/names stay unchanged and neither graph emits class nodes; unsupported or unextractable callables therefore also block in this case. Dots in an opaque ID are not ownership evidence. Stable explicit class ownership can establish preservation without parsing. Identical current descriptors within one HEAD may preserve repair references; this does not waive verification of the previous published symbols across revisions.
