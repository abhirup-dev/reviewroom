import { parseSync, Visitor, type Expression } from 'oxc-parser';

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

const named = (e: Expression, name: string) => e.type === 'MemberExpression' && !e.computed && e.property.type === 'Identifier' && e.property.name === name;
/** `this.services.<x>.<y>`, the member a forwarding method returns. */
function servicesMember(e: Expression | null | undefined) {
  if (e?.type !== 'MemberExpression' || e.object.type !== 'MemberExpression') return false;
  const services = e.object.object;
  return named(services, 'services') && services.type === 'MemberExpression' && services.object.type === 'ThisExpression';
}

/** Methods and getters of a class that only return `this.services.<x>.<y>(...)` (or the member itself). */
export function serviceForwarders(file: string, source: string, className: string) {
  const names: string[] = [];
  new Visitor({
    ClassDeclaration(c) {
      if (c.id?.name !== className) return;
      for (const m of c.body.body) {
        if (m.type !== 'MethodDefinition' || m.kind === 'constructor' || m.key.type !== 'Identifier') continue;
        const body = m.value.body?.body;
        const only = body?.length === 1 && body[0].type === 'ReturnStatement' ? body[0].argument : null;
        if (servicesMember(only) || (only?.type === 'CallExpression' && only.callee.type !== 'Super' && servicesMember(only.callee))) names.push(m.key.name);
      }
    },
  }).visit(parseSync(file, source).program);
  return names;
}
