import { expect, test } from 'bun:test';
import { withoutPanels } from './dockjson';

test('dropping panels prunes empty groups and splits', () => {
  const layout = {
    grid: { root: { type: 'branch' as const, data: [
      { type: 'leaf' as const, data: { id: '1', views: ['narrative', 'thread:t1'], activeView: 'thread:t1' } },
      { type: 'branch' as const, data: [{ type: 'leaf' as const, data: { id: '2', views: ['code:2'] } }] },
      { type: 'leaf' as const, data: { id: '3', views: ['code'] } },
    ] }, width: 100, height: 100 },
    panels: { narrative: {}, 'thread:t1': {}, 'code:2': {}, code: {} },
    floatingGroups: [{ data: { id: '4', views: ['thread:t2'] } }],
  };
  const out = withoutPanels(layout, (id) => id.includes(':'));
  expect(Object.keys(out.panels)).toEqual(['narrative', 'code']);
  expect(out.grid.root.data).toEqual([
    { type: 'leaf', data: { id: '1', views: ['narrative'], activeView: 'narrative' } },
    { type: 'leaf', data: { id: '3', views: ['code'], activeView: 'code' } },
  ]);
  expect(out.floatingGroups).toEqual([]);
});
