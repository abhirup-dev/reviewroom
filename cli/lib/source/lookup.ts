import { DeclarationLookupInput, DeclarationLookupResult } from './model';
import { withSnapshot } from './snapshot';
import { declarations } from './outline';

/** Declaration lookup, not semantic binding/reference resolution. Empty results never imply complete language coverage. */
export async function lookupDeclarations(input: DeclarationLookupInput): Promise<DeclarationLookupResult> {
  const { repo, revision, queries } = DeclarationLookupInput.parse(input);
  return withSnapshot(repo, revision, async (snapshot) => {
    const issues: string[] = [];
    const found = await declarations(snapshot.root, snapshot.files, [...new Set(queries.map((q) => q.name))]).catch((e: unknown) => {
      issues.push(e instanceof Error ? e.message : String(e));
      return { declarations: [], unverified: snapshot.files.map((f) => f.path) };
    });
    const results = queries.map((query) => {
      const matches = found.declarations.filter((d) => d.name === query.name &&
      (!query.path || d.path === query.path || d.path.endsWith('/' + query.path)) &&
      (!query.owner || d.owners.includes(query.owner) || d.path.split('/').includes(query.owner)))
      .sort((a, b) => a.path.localeCompare(b.path) || a.range.start.line - b.range.start.line);
      return { query, status: matches.length ? 'found' : 'unverified', declarations: matches };
    });
    return DeclarationLookupResult.parse({ snapshot: { repo: snapshot.repo, revision: snapshot.revision }, results,
      coverage: { filesConsidered: snapshot.files.length, unverifiedFiles: [...snapshot.excluded, ...found.unverified], skippedFiles: snapshot.skipped, issues } });
  });
}
