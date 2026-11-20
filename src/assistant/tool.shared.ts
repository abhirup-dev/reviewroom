// How a tool call reads in the assistant's transcript: a verb and a short target, one quiet row (DESIGN.md, Assistant).

const VERB: Record<string, string> = { Bash: 'Ran', Read: 'Read', Grep: 'Search', Glob: 'Find', Edit: 'Edit', MultiEdit: 'Edit', Write: 'Wrote', NotebookEdit: 'Edit', WebFetch: 'Fetch', WebSearch: 'Search', Task: 'Agent', TodoWrite: 'Plan', fileChange: 'Wrote' }; // fileChange: the ACP harness's name for an edit
const TARGET = ['command', 'file_path', 'path', 'pattern', 'skill', 'url', 'query', 'description'] as const;

export const toolVerb = (name: string) => VERB[name] ?? name;

/** The row's target: a command without its `cd dir &&` and `NAME=value;` preamble, a path's last three parts, else the
 *  first string argument that names what the call is about. */
export function toolTarget(args: Record<string, unknown> | undefined): string {
  for (const k of TARGET) {
    const v = args?.[k];
    if (typeof v !== 'string' || !v) continue;
    if (k === 'command') return v.replace(/^(?:\s*(?:cd\s+\S+|[A-Za-z_]\w*=\S*)\s*(?:&&|;)\s*)+/, '').trim() || v;
    if (k === 'file_path' || k === 'path') return v.split('/').filter(Boolean).slice(-3).join('/');
    return v;
  }
  return '';
}
