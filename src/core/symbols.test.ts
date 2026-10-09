import { expect, test } from 'bun:test';
import { declaration, linkedSymbol, namedIdentifier } from './symbols';

test('declarations across languages', () => {
  expect(declaration('func (h *Helper) FillCounterColumn(name string) {')).toEqual({ name: 'FillCounterColumn', kind: 'method' });
  expect(declaration('func sameAggRanges(a, b []string) bool {')).toEqual({ name: 'sameAggRanges', kind: 'function' });
  expect(declaration('type TfFeaturesBatch struct {')).toEqual({ name: 'TfFeaturesBatch', kind: 'struct' });
  expect(declaration('type Set[T comparable] struct {')).toEqual({ name: 'Set', kind: 'struct' });
  expect(declaration('type Adapter interface {')).toEqual({ name: 'Adapter', kind: 'interface' });
  expect(declaration('type Opt func(*cfg)')).toEqual({ name: 'Opt', kind: 'type' });
  expect(declaration('export async function load(x) {')).toEqual({ name: 'load', kind: 'function' });
  expect(declaration('export class ReviewApp {')).toEqual({ name: 'ReviewApp', kind: 'class' });
  expect(declaration('export const defaultPrefs: Prefs = {')).toEqual({ name: 'defaultPrefs', kind: 'const' });
  expect(declaration('    def parse(self, raw):')).toEqual({ name: 'parse', kind: 'function' });
  expect(declaration('pub(crate) async fn run() {')).toEqual({ name: 'run', kind: 'function' });
  expect(declaration('message FeatureRequest {')).toEqual({ name: 'FeatureRequest', kind: 'struct' });
  expect(declaration('  rpc GetFeatures(Req) returns (Resp);')).toEqual({ name: 'GetFeatures', kind: 'method' });
  expect(declaration('  return x + 1')).toBeNull();
});

test('only links that name the declared symbol get a kind', () => {
  expect(namedIdentifier('ps.svc.parseCountersResponse()')).toBe('parseCountersResponse');
  expect(namedIdentifier('column fill per feature')).toBeNull();
  expect(linkedSymbol('FillCounterColumn', 'func (h *Helper) FillCounterColumn(x int) {')).toBe('method');
  expect(linkedSymbol('cached index table', 'if featureIdxTable == nil {')).toBeNull();
  expect(linkedSymbol('Other', 'func Fill() {')).toBeNull();
});

test('targets may start on a doc comment above the declaration', () => {
  expect(linkedSymbol('GetBatchExamplesFor', ['// GetBatchExamplesFor is restricted.', 'func (f *D) GetBatchExamplesFor(ids []string) {'])).toBe('method');
  expect(linkedSymbol('GetExamplesForEntityIds', ['/*', 'GetExamplesForEntityIds is …', '*/', 'func (r *B) GetExamplesForEntityIds() {'])).toBe('method');
  expect(linkedSymbol('parse', ['@cache', 'def parse(raw):'])).toBe('function');
  expect(linkedSymbol('Span', ['#[derive(Debug)]', 'pub struct Span {'])).toBe('struct');
  expect(linkedSymbol('FillTfsFeatureValue', ['\t\terr := h.FillTfsFeatureValue(i, name, v)'])).toBeNull();
});
