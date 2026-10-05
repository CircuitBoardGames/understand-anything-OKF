import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { traverse } from "./base-extractor.js";

/**
 * Shell (tree-sitter-bash). A shell function is global once its definition runs,
 * wherever it is nested, so every `function_definition` is a free function.
 * Shell has no classes, typed parameters, imports or exports in this model.
 */
export class ShellExtractor implements LanguageExtractor {
  readonly languageIds = ["shell"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    traverse(rootNode, (node) => {
      const name = node.type === "function_definition" ? node.childForFieldName("name") : null;
      if (name) functions.push({ name: name.text, lineRange: [node.startPosition.row + 1, node.endPosition.row + 1], params: [] });
    });
    return { functions, classes: [], imports: [], exports: [] };
  }

  // ponytail: no shell call graph yet (shell had no structural analysis before
  // this extractor). Add one by matching `command_name` against defined functions.
  extractCallGraph(): CallGraphEntry[] {
    return [];
  }
}
