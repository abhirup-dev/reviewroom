// Writes schema/state.schema.json from the Zod schema in src/shared/schema.ts. `bun run schema`
// after changing it; src/shared/schema.test.ts fails while the committed file is out of date.
import { writeFileSync } from 'node:fs';
import { stateJsonSchema } from '../src/shared/schema';

export const schemaFile = new URL('../schema/state.schema.json', import.meta.url).pathname;
export const render = () => JSON.stringify(stateJsonSchema(), null, 2) + '\n';

if (import.meta.main) writeFileSync(schemaFile, render());
