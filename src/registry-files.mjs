// The registry on disk is two files: data/crossings.json holds the
// hand-written entries, pretty-printed for editing; data/generated.json
// holds the generator's output, one compact entry per line (it is a few MB —
// indented it was twice that, for nothing).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const HAND = path.join(here, '..', 'data', 'crossings.json');
export const GENERATED = path.join(here, '..', 'data', 'generated.json');

const readList = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };

/** Hand-written entries first, then generated. */
export function readRegistry() {
  return [...readList(HAND), ...readList(GENERATED)];
}

export function writeRegistry(list) {
  const hand = list.filter((c) => !c.generated);
  const generated = list.filter((c) => c.generated);
  writeFileSync(HAND, JSON.stringify(hand, null, 1) + '\n');
  writeFileSync(GENERATED, `[\n${generated.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`);
}
