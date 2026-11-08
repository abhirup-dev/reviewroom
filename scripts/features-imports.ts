import { parseSync, Visitor } from 'oxc-parser';

/** Phone code (Refactor 3.0, rr-486): *.phone.ts and the modules only the phone uses. Core never imports it
 *  (scripts/features.ts), and the desktop never loads it (src/main.ts imports src/phone.ts lazily; scripts/build.ts checks). */
const PHONE = new Set(['src/phone.ts', 'src/turned.ts', 'src/kernel/phone.ts', 'src/kernel/shell.machine.ts', 'src/kernel/gesture.machine.ts', 'src/kernel/codesheet.machine.ts', 'src/kernel/history.ts', 'src/slides/phone.machine.ts', 'src/slides/nav.machine.ts']);
export const isPhone = (file: string) => file.endsWith('.phone.ts') || PHONE.has(file);

/** Parse dependencies before type erasure, including inline type specifiers and side-effect imports. */
export function moduleImports(file: string, source: string) {
  const parsed = parseSync(file, source);
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors.map(e => e.message).join('; ')}`);
  const imports: { path: string; typeOnly: boolean }[] = [];
  const add = (path: string, typeOnly = false) => { imports.push({ path, typeOnly }); };
  new Visitor({
    ImportDeclaration(n) {
      add(n.source.value, n.importKind === 'type' || (n.specifiers.length > 0 && n.specifiers.every(s => s.type === 'ImportSpecifier' && s.importKind === 'type')));
    },
    ExportNamedDeclaration(n) {
      if (n.source) add(n.source.value, n.exportKind === 'type' || (n.specifiers.length > 0 && n.specifiers.every(s => s.exportKind === 'type')));
    },
    ExportAllDeclaration(n) { add(n.source.value, n.exportKind === 'type'); },
    ImportExpression(n) { if (n.source.type === 'Literal' && typeof n.source.value === 'string') add(n.source.value); },
    TSImportType(n) { add(n.source.value, true); },
    TSImportEqualsDeclaration(n) {
      if (n.moduleReference.type === 'TSExternalModuleReference') add(n.moduleReference.expression.value, n.importKind === 'type');
    },
  }).visit(parsed.program);
  return imports;
}
