// Layout files: a small declarative tree of splits and tab stacks. The shipped layouts, the reviewer's default and
// their named layouts are all this shape; the dock loads one by compiling it to dockview's own JSON.
import { z } from 'zod';
import reading from './reading.json';
import wideCode from './wide-code.json';
import codeFocus from './code-focus.json';
import narrativeFocus from './narrative-focus.json';
import tablet from './tablet.json';

/** `size` along the parent split: > 1 is pixels, <= 1 a fraction of what the pixel-sized siblings leave;
 *  unsized children share the rest. A split inside a split of the same direction is flattened. */
export type LayoutNode = { size?: number } & ({ tabs: string[]; active?: string } | { row: LayoutNode[] } | { column: LayoutNode[] });
export type Layout = { title: string; hint?: string; root: LayoutNode };

const size = z.number().positive().optional();
export const LayoutNode: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([z.object({ size, tabs: z.array(z.string()).min(1), active: z.string().optional() }), z.object({ size, row: z.array(LayoutNode).min(1) }), z.object({ size, column: z.array(LayoutNode).min(1) })]),
);
export const Layout = z.object({ title: z.string().min(1), hint: z.string().optional(), root: LayoutNode });
/** A layout file's name: what it's saved as and how menus, `layout=""` and `rr.layout()` refer to it. */
export const LayoutId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
/** The id a layout saved as `title` gets ('' if the title has no letters or digits). */
export const layoutId = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
/** The layouts reviewroom ships (src/kernel/layouts/): always there, never replaced by a saved one. */
export const builtinLayouts = { reading, 'wide-code': wideCode, 'code-focus': codeFocus, 'narrative-focus': narrativeFocus, tablet } as Record<string, Layout>;

// dockview's serialised grid, as much of it as this file reads and writes
type Orientation = 'HORIZONTAL' | 'VERTICAL';
type DockNode = { type: 'leaf' | 'branch'; data: DockGroup | DockNode[]; size?: number };
type DockGroup = { views: string[]; activeView?: string; id: string };
export type DockJSON = { grid: { root: DockNode; width: number; height: number; orientation: Orientation }; panels: Record<string, { id: string; contentComponent?: string; title?: string; params?: Record<string, unknown> }> };
type Panel = DockJSON['panels'][string];
/** The reviewer's saved layouts by id, and which one (if any) is their default. */
export type SavedLayouts = { layouts: Record<string, Layout>; default: string | null };
/** A review's own layout: its dock as the reviewer left it (on-demand panels too), the PR panels it has offered,
 *  and the layout the dock was built from (where closed panels go back to). */
export type LastLayout = { dock: DockJSON; offered: string[]; layout?: string };

const kids = (n: LayoutNode) => ('row' in n ? n.row : 'column' in n ? n.column : null);
const dir = (n: LayoutNode) => ('row' in n ? 'row' : 'column');
// a HORIZONTAL branch lays its children out side by side
const orientation = (d: 'row' | 'column'): Orientation => (d === 'row' ? 'HORIZONTAL' : 'VERTICAL');

/** The tree with only the panels `keep` accepts; empty stacks and splits go, one-child splits collapse. */
function prune(n: LayoutNode, keep: (id: string) => boolean): LayoutNode | null {
  const k = kids(n);
  if (!k) {
    const tabs = (n as { tabs: string[] }).tabs.filter(keep);
    const active = (n as { active?: string }).active;
    return tabs.length ? { size: n.size, tabs, active: active && tabs.includes(active) ? active : undefined } : null;
  }
  const left = k.map((c) => prune(c, keep)).filter((c): c is LayoutNode => !!c);
  if (!left.length) return null;
  if (left.length === 1) return { ...left[0], size: n.size };
  return dir(n) === 'row' ? { size: n.size, row: left } : { size: n.size, column: left };
}

/** Pixel sizes for `sizes` along an extent (see LayoutNode), summing to it. */
export function distribute(sizes: (number | undefined)[], extent: number): number[] {
  const px = sizes.reduce((s: number, v) => s + (v && v > 1 ? v : 0), 0);
  const rest = Math.max(0, extent - px);
  const fixed = sizes.map((v) => (v === undefined ? undefined : v > 1 ? v : v * rest));
  const free = sizes.filter((v) => v === undefined).length;
  const share = Math.max(0, extent - fixed.reduce((s: number, v) => s + (v ?? 0), 0)) / (free || 1);
  const raw = fixed.map((v) => v ?? share);
  const total = raw.reduce((s, v) => s + v, 0) || 1;
  const out = raw.map((v) => Math.round((v * extent) / total));
  out[out.length - 1] += extent - out.reduce((s, v) => s + v, 0);
  return out;
}

/** dockview JSON for `layout` in a width x height dock, with the panels `panel` describes (others are left out). */
export function toDockview(layout: LayoutNode, width: number, height: number, panel: (id: string) => Panel | undefined): DockJSON | null {
  const panels: DockJSON['panels'] = {};
  const root = prune(layout, (id) => {
    if (id in panels) return false; // a panel listed twice stays where it's listed first
    const p = panel(id);
    if (p) panels[id] = p;
    return !!p;
  });
  if (!root) return null;
  let gid = 0;
  // `axis` is the direction of the dockview branch these nodes go into; same-direction splits merge into it
  const emit = (n: LayoutNode, axis: 'row' | 'column', w: number, h: number): DockNode[] => {
    const k = kids(n);
    if (!k) {
      const { tabs, active } = n as { tabs: string[]; active?: string };
      return [{ type: 'leaf', data: { id: String(++gid), views: tabs, activeView: active ?? tabs[0] }, size: axis === 'row' ? w : h }];
    }
    const d = dir(n);
    const sizes = distribute(k.map((c) => c.size), d === 'row' ? w : h);
    const children = k.flatMap((c, i) => emit(c, d, d === 'row' ? sizes[i] : w, d === 'row' ? h : sizes[i]));
    return d === axis ? children : [{ type: 'branch', data: children, size: axis === 'row' ? w : h }];
  };
  // the grid's root is always a branch: a lone stack becomes a row of one
  const d = kids(root) ? dir(root) : 'row';
  const top = kids(root) ? emit(root, d === 'row' ? 'column' : 'row', width, height)[0] : { type: 'branch' as const, data: emit(root, 'row', width, height), size: height };
  return { grid: { root: top, width, height, orientation: orientation(d) }, panels };
}

/** The declarative layout of a dock (floating and popped-out windows aren't part of it), with only the panels `keep` accepts. */
export function fromDockview(json: DockJSON, keep: (id: string) => boolean): LayoutNode | null {
  const node = (n: DockNode, o: Orientation, size?: number): LayoutNode => {
    if (n.type === 'leaf') {
      const g = n.data as DockGroup;
      return { size, tabs: g.views, active: g.views.length > 1 ? g.activeView : undefined };
    }
    const k = n.data as DockNode[];
    const total = k.reduce((s, c) => s + (c.size ?? 0), 0) || 1;
    const next: Orientation = o === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL';
    const children = k.map((c) => node(c, next, c.size ? Math.round((c.size / total) * 1000) / 1000 : undefined));
    return o === 'HORIZONTAL' ? { size, row: children } : { size, column: children };
  };
  const root = prune(node(json.grid.root, json.grid.orientation), keep);
  return root && { ...root, size: undefined };
}

export type Placement = { ref?: string; dir: 'within' | 'left' | 'right' | 'above' | 'below'; size?: number; px?: number };
/** Where to add panel `id` to a dock already holding the panels `open` accepts, so it lands where `layout` puts it:
 *  as a tab beside an open stack-mate, else beside the nearest open sibling (`size` from the layout, unresolved). */
export function placement(layout: LayoutNode, id: string, open: (id: string) => boolean): Placement | undefined {
  const path: LayoutNode[] = [];
  const find = (n: LayoutNode): boolean => {
    path.push(n);
    if (kids(n)?.some(find) ?? (n as { tabs: string[] }).tabs.includes(id)) return true;
    path.pop();
    return false;
  };
  if (!find(layout)) return undefined;
  const panels = (n: LayoutNode): string[] => kids(n)?.flatMap(panels) ?? (n as { tabs: string[] }).tabs.filter(open);
  const stacks = (n: LayoutNode): number => kids(n)?.reduce((sum, c) => sum + stacks(c), 0) ?? Number(panels(n).length > 0);
  const mate = panels(path.at(-1)!)[0];
  if (mate) return { ref: mate, dir: 'within' };
  for (let d = path.length - 2; d >= 0; d--) {
    const k = kids(path[d])!;
    const i = k.indexOf(path[d + 1]);
    const row = dir(path[d]) === 'row';
    // open siblings, nearest first (after before before); one that is a single stack is best, as dockview can only
    // split a stack: beside a stack inside a bigger split, the panel would end up inside that split
    const near = [...Array(k.length).keys()].flatMap((off) => [i + off, i - off]).filter((j, n, all) => j !== i && k[j] && panels(k[j]).length && all.indexOf(j) === n);
    if (!near.length) continue;
    const j = near.find((x) => stacks(k[x]) === 1) ?? near[0];
    const there = panels(k[j]);
    const after = j > i;
    // outermost beside a whole side of the dock: the dock's edge
    const edge = d === 0 && stacks(k[j]) > 1 && (after ? k.slice(0, i) : k.slice(i + 1)).every((c) => !panels(c).length);
    const ref = edge ? undefined : after ? there[0] : there.at(-1);
    // a fraction is of what pixel-sized siblings leave
    const px = k.reduce((sum, c, x) => sum + (x !== i && c.size && c.size > 1 && panels(c).length ? c.size : 0), 0);
    return { ref, dir: row ? (after ? 'left' : 'right') : after ? 'above' : 'below', size: path[d + 1].size, px };
  }
  return undefined;
}
