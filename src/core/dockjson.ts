// Edits on dockview's serialised layout (pure, so it can be tested without a dock).
type Node = { type: 'branch' | 'leaf'; data: Group | Node[]; size?: number };
type Group = { views: string[]; activeView?: string; id: string };

/** The layout without the panels `drop` names (and any group or split left empty by that). */
export function withoutPanels<T extends { grid: { root: Node }; panels: Record<string, unknown>; floatingGroups?: { data: Group }[]; popoutGroups?: { data: Group }[] }>(layout: T, drop: (id: string) => boolean): T {
  const group = (g: Group): Group | null => {
    const views = g.views.filter((v) => !drop(v));
    return views.length ? { ...g, views, activeView: views.includes(g.activeView!) ? g.activeView : views[0] } : null;
  };
  const node = (n: Node): Node | null => {
    if (n.type === 'leaf') {
      const g = group(n.data as Group);
      return g ? { ...n, data: g } : null;
    }
    const kids = (n.data as Node[]).map(node).filter(Boolean) as Node[];
    return kids.length ? { ...n, data: kids } : null;
  };
  const panels = Object.fromEntries(Object.entries(layout.panels).filter(([id]) => !drop(id)));
  const floats = (gs?: { data: Group }[]) => gs?.flatMap((f) => (group(f.data) ? [{ ...f, data: group(f.data)! }] : []));
  return { ...layout, grid: { ...layout.grid, root: node(layout.grid.root) ?? { type: 'branch', data: [] } }, panels, floatingGroups: floats(layout.floatingGroups), popoutGroups: floats(layout.popoutGroups) };
}
