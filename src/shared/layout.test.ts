import { expect, test } from 'bun:test';
import { distribute, fromDockview, Layout, placement, toDockview, type LayoutNode } from './layout';
import reading from '../layouts/reading.json';
import wideCode from '../layouts/wide-code.json';
import codeFocus from '../layouts/code-focus.json';
import narrativeFocus from '../layouts/narrative-focus.json';
import tablet from '../layouts/tablet.json';

const panel = (id: string) => (id.includes(':') ? undefined : { id, contentComponent: id, title: id });
const ids = (n: LayoutNode): string[] => ('tabs' in n ? n.tabs : ('row' in n ? n.row : n.column).flatMap(ids));

test('built-in layouts are valid layout files', () => {
  for (const l of [reading, wideCode, codeFocus, narrativeFocus, tablet]) expect(Layout.safeParse(l).success).toBe(true);
});

test('pixels first, fractions of the rest, unsized share what is left', () => {
  expect(distribute([264, undefined, 0.5], 1264)).toEqual([264, 500, 500]);
  expect(distribute([undefined, undefined], 101)).toEqual([51, 50]);
  expect(distribute([0.3, 0.3], 100)).toEqual([50, 50]); // too little asked for: scaled to fill
});

test('compiles to a dockview grid: rows alternate with columns, same-direction splits merge', () => {
  const root: LayoutNode = { row: [{ size: 200, tabs: ['toc'] }, { row: [{ tabs: ['narrative'] }, { tabs: ['code', 'thread:1'], active: 'code' }] }] };
  const j = toDockview(root, 1000, 600, panel)!;
  expect(j.grid.orientation).toBe('HORIZONTAL');
  expect(j.grid.root.data).toEqual([
    { type: 'leaf', data: { id: '1', views: ['toc'], activeView: 'toc' }, size: 200 },
    { type: 'leaf', data: { id: '2', views: ['narrative'], activeView: 'narrative' }, size: 400 },
    { type: 'leaf', data: { id: '3', views: ['code'], activeView: 'code' }, size: 400 },
  ]);
  expect(Object.keys(j.panels)).toEqual(['toc', 'narrative', 'code']);
});

test('panels the dock leaves out take their stack and split with them', () => {
  const j = toDockview(reading.root, 1264, 800, (id) => (id === 'description' || id === 'ci' ? undefined : panel(id)))!;
  const [side, middle, code] = j.grid.root.data as { type: string; data: unknown; size: number }[];
  expect(side.size).toBe(264);
  expect(middle).toMatchObject({ type: 'leaf', data: { views: ['narrative'] }, size: 500 });
  expect(code.size).toBe(500);
  expect(toDockview({ tabs: ['thread:1'] }, 10, 10, panel)).toBeNull();
});

test('a dock round-trips through the layout format', () => {
  const j = toDockview(wideCode.root, 1264, 1000, panel)!;
  const back = fromDockview(j, (id) => !id.includes(':'))!;
  expect(ids(back)).toEqual(ids(wideCode.root as LayoutNode));
  expect(toDockview(back, 1264, 1000, panel)!.grid).toEqual(j.grid);
});

test('a missing panel goes back beside its stack-mate, else its nearest open sibling', () => {
  const open = (...xs: string[]) => (id: string) => xs.includes(id);
  const r = reading.root as LayoutNode;
  expect(placement(r, 'ci', open('threads', 'narrative'))).toEqual({ ref: 'threads', dir: 'within' });
  expect(placement(r, 'description', open('narrative', 'code'))).toEqual({ ref: 'narrative', dir: 'above', size: 0.4, px: 0 });
  expect(placement(r, 'code', open('narrative'))).toEqual({ ref: 'narrative', dir: 'right', size: 0.5, px: 0 });
  // beside a split of several stacks, at the dock's edge: a fraction of what the 264px sidebar leaves
  expect(placement(r, 'code', open('toc', 'files', 'narrative', 'description'))).toEqual({ ref: undefined, dir: 'right', size: 0.5, px: 264 });
  expect(placement(r, 'narrative', open('toc', 'code'))).toEqual({ ref: 'code', dir: 'left', size: undefined, px: 264 });
  expect(placement(r, 'toc', open('narrative', 'code'))).toEqual({ ref: 'narrative', dir: 'left', size: 264, px: 0 });
  expect(placement(r, 'toc', open('files', 'narrative'))).toEqual({ ref: 'files', dir: 'above', size: undefined, px: 0 });
  expect(placement(wideCode.root as LayoutNode, 'description', open('narrative', 'code'))).toEqual({ ref: 'narrative', dir: 'left', size: 0.33, px: 0 });
  // between a single stack and a column of two: beside the single stack, so it doesn't land inside the column
  expect(placement(codeFocus.root as LayoutNode, 'code', open('files', 'narrative', 'threads'))).toEqual({ ref: 'files', dir: 'right', size: undefined, px: 264 });
  expect(placement(r, 'nope', open('narrative'))).toBeUndefined();
});
