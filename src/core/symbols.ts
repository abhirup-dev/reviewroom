// What a code link points at, inferred from the declaration on the first line it targets.

export type SymbolKind = 'function' | 'method' | 'struct' | 'class' | 'interface' | 'type' | 'enum' | 'const';

// Order matters: specific forms before general ones (Go `type X struct` before `type X`).
const DECLS: [RegExp, SymbolKind][] = [
  [/^\s*func\s+\([^)]*\)\s*(\w+)/, 'method'], // Go method
  [/^\s*func\s+(\w+)/, 'function'], // Go
  [/^\s*type\s+(\w+)(?:\[[^\]]*\])?\s+struct\b/, 'struct'], // Go
  [/^\s*type\s+(\w+)(?:\[[^\]]*\])?\s+interface\b/, 'interface'], // Go
  [/^\s*(?:export\s+)?(?:declare\s+)?type\s+(\w+)/, 'type'], // Go, TS
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)/, 'function'], // JS/TS
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, 'class'], // JS/TS, Python, Kotlin…
  [/^\s*(?:export\s+)?interface\s+(\w+)/, 'interface'], // TS, Java
  [/^\s*(?:export\s+)?(?:const\s+)?enum\s+(\w+)/, 'enum'], // TS, proto
  [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)/, 'const'], // JS/TS, Go
  [/^\s*(?:async\s+)?def\s+(\w+)/, 'function'], // Python
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, 'function'], // Rust
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, 'struct'], // Rust
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, 'enum'], // Rust
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, 'interface'], // Rust
  [/^\s*message\s+(\w+)/, 'struct'], // proto
  [/^\s*service\s+(\w+)/, 'interface'], // proto
  [/^\s*rpc\s+(\w+)/, 'method'], // proto
];

export function declaration(line: string): { name: string; kind: SymbolKind } | null {
  for (const [re, kind] of DECLS) {
    const m = re.exec(line);
    if (m) return { name: m[1], kind };
  }
  return null;
}

/** The identifier a link's text names: `ps.svc.Parse()` → `Parse`; null for prose. */
export function namedIdentifier(text: string): string | null {
  const t = text.trim().replace(/\(\)$/, '');
  const m = /^(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)$/.exec(t);
  return m ? m[1] : null;
}

/** First code line of a target range, skipping leading blank lines, comments and decorators. */
export function firstCodeLine(lines: string[]): string | undefined {
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (inBlock) {
      inBlock = !t.includes('*/');
      continue;
    }
    if (t.startsWith('/*')) {
      inBlock = !t.includes('*/', 2);
      continue;
    }
    if (!t || /^(\/\/|#|@|--)/.test(t)) continue;
    return line;
  }
}

/** Kind of the symbol a link names, if the targeted code declares exactly that symbol. */
export function linkedSymbol(linkText: string, target: string | string[]): SymbolKind | null {
  const name = namedIdentifier(linkText);
  const line = typeof target === 'string' ? target : firstCodeLine(target);
  const decl = name && line ? declaration(line) : null;
  return decl && decl.name === name ? decl.kind : null;
}
