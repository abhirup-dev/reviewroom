// Writes schema/state.schema.json and schema/walkthrough.schema.json from the Zod schemas in *.shared.ts.
// `bun run schema` after changing them; src/kernel/state/schema.shared.test.ts fails while a committed file is out of date.
import { writeFileSync } from 'node:fs';
import { stateJsonSchema } from '../src/kernel/state/schema.shared';
import { walkthroughJsonSchema } from '../src/walkthrough/model.shared';

const file = (name: string) => new URL(`../schema/${name}`, import.meta.url).pathname;
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/** Each generated file and its expected content. */
export const schemas = () => [
  { file: file('state.schema.json'), content: json(stateJsonSchema()) },
  { file: file('walkthrough.schema.json'), content: json(walkthroughJsonSchema()) },
];

if (import.meta.main) for (const s of schemas()) writeFileSync(s.file, s.content);
