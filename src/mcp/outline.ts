import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';

/** Structural outline via web-tree-sitter (grammars from @vscode/tree-sitter-wasm). */

const require = createRequire(import.meta.url);
const WASM_DIR = dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'));

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'c-sharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.h': 'cpp',
  '.php': 'php',
  '.rb': 'ruby',
  '.css': 'css',
  '.sh': 'bash',
  '.bash': 'bash',
};

interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: (TsNode | null)[];
  childForFieldName(name: string): TsNode | null;
}

interface TsParser {
  setLanguage(lang: unknown): void;
  parse(text: string): { rootNode: TsNode; delete(): void } | null;
}

interface TsModule {
  Parser: { init(opts: { locateFile: (file: string) => string }): Promise<void>; new (): TsParser };
  Language: { load(path: string): Promise<unknown> };
}

export interface OutlineSymbol {
  /** 1-based inclusive lines. */
  start: number;
  end: number;
  depth: number;
  label: string;
}

let runtime: Promise<TsModule> | undefined;
const parsers = new Map<string, Promise<TsParser>>();

function parserFor(language: string): Promise<TsParser> {
  runtime ??= (async () => {
    const mod = require('@vscode/tree-sitter-wasm/wasm/tree-sitter.js') as TsModule;
    await mod.Parser.init({ locateFile: (file) => join(WASM_DIR, file) });
    return mod;
  })();
  let p = parsers.get(language);
  if (!p) {
    p = runtime.then(async (mod) => {
      const parser = new mod.Parser();
      parser.setLanguage(await mod.Language.load(join(WASM_DIR, `tree-sitter-${language}.wasm`)));
      return parser;
    });
    parsers.set(language, p);
  }
  return p;
}

const DECLARATION = /(^|_)(function|method|class|interface|enum|type_alias|type|struct|impl|trait|mod|module|namespace|constructor)(_declaration|_definition|_item|_signature|_spec)$/;
const CLASS_LIKE = /(class|interface|struct|impl|trait|mod|module|namespace|enum)/;
const FUNCTION_VALUE = new Set(['arrow_function', 'function_expression', 'function', 'class', 'generator_function']);
const MAX_SYMBOL_DEPTH = 2;

function label(node: TsNode): string {
  let first = node.text.split('\n', 1)[0]!.replace(/\s+/g, ' ');
  const arrow = first.indexOf(' => ');
  if (arrow >= 0) first = first.slice(0, arrow + 3);
  first = first.replace(/\s*[{:]\s*$/, '').trim();
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}

// Bodies that hold implementation details, skipped unless they are the body of a class-like symbol.
const BODY = /(statement_block|^block$|function_body|arguments|call_expression)/;

function collect(node: TsNode, depth: number, out: OutlineSymbol[], classBody = false, inherited = ''): void {
  // Declarations wrapped in export_statement keep the keyword in their label.
  const prefix = node.type === 'export_statement' ? (/^export\s+default\b/.test(node.text) ? 'export default ' : 'export ') : inherited;
  for (const child of node.namedChildren) {
    if (!child) continue;
    const start = child.startPosition.row + 1;
    const end = child.endPosition.row + 1;
    if (DECLARATION.test(child.type)) {
      out.push({ start, end, depth, label: prefix + label(child) });
      // Members of classes/modules are listed; bodies of functions are not.
      if (depth + 1 < MAX_SYMBOL_DEPTH && CLASS_LIKE.test(child.type)) collect(child, depth + 1, out, true);
    } else if (child.type === 'variable_declarator' && FUNCTION_VALUE.has(child.childForFieldName('value')?.type ?? '')) {
      out.push({ start, end, depth, label: prefix + label(child) });
    } else if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
      collect(child, depth, out, false, prefix);
    } else if (classBody || !BODY.test(child.type)) {
      collect(child, depth, out);
    }
  }
}

export const outlineLanguage = (path: string): string | undefined => LANGUAGES[extname(path).toLowerCase()];

/** Returns undefined for unsupported languages. */
export async function outline(path: string, text: string): Promise<OutlineSymbol[] | undefined> {
  const language = outlineLanguage(path);
  if (!language) return undefined;
  const parser = await parserFor(language);
  const tree = parser.parse(text);
  if (!tree) return undefined;
  const symbols: OutlineSymbol[] = [];
  collect(tree.rootNode, 0, symbols);
  tree.delete();
  return symbols;
}
