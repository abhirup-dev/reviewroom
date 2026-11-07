import { expect, test } from 'bun:test';
import { formFor, presentationFor, type Form } from './presentation';

test('formFor: a phone upright gets the phone shell, on its side the dock; ?phone forces the shell anywhere', () => {
  const cases: [boolean, boolean, boolean, Form][] = [
    // small, landscape, forced -> form
    [false, false, false, 'desktop'],
    [false, true, false, 'desktop'],
    [true, false, false, 'phone'],
    [true, true, false, 'turned'],
    [false, true, true, 'phone'],
    [true, true, true, 'phone'],
  ];
  for (const [small, landscape, forced, form] of cases) expect([small, landscape, forced, formFor({ small, landscape, forced })]).toEqual([small, landscape, forced, form]);
});

test('presentationFor: the turned phone keeps the dock but plays the phone player', () => {
  expect(presentationFor('desktop')).toMatchObject({ kind: 'dock', canArrange: true, phonePlayer: false, threadPopup: 'dialog', prefs: { key: 'reviewroom:prefs' } });
  expect(presentationFor('turned')).toMatchObject({ kind: 'dock', canArrange: true, phonePlayer: true, threadPopup: 'dialog', prefs: { key: 'reviewroom:prefs' } });
  expect(presentationFor('phone')).toMatchObject({ kind: 'phone', canArrange: false, phonePlayer: true, threadPopup: 'sheet', prefs: { key: 'reviewroom:prefs:phone', defaults: { diffStyle: 'unified' } } });
});
