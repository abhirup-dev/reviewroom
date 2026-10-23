// A Bun macro (imported `with { type: 'macro' }`): runs at bundle time, so only this map ships, not the emoji data.
import data from 'emoji-picker-element-data/en/github/data.json';

/** GitHub's emoji shortcodes (`+1`, `tada`) -> the emoji. */
export const githubEmoji = (): Record<string, string> => Object.fromEntries(data.flatMap((e) => (e.shortcodes ?? []).map((s) => [s, e.emoji])));
