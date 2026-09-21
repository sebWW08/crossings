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
// Hand corrections keyed by id, merged over whichever entry they name:
// what people at the barrier reported, kept apart from the generator's
// output so a regeneration doesn't undo them.
export const OVERRIDES = path.join(here, '..', 'data', 'overrides.json');

const readList = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };

/** Apply an override to an entry: top-level fields replace, `station` merges. */
export function applyOverride(entry, o) {
  if (!o) return entry;
  const { station, ...rest } = o;
  return { ...entry, ...rest, ...(station ? { station: { ...entry.station, ...station } } : {}) };
}

/** Hand-written entries first, then generated, each with its override (if
 *  any) on top — unless `raw`, which the generator uses so it never writes
 *  an override back into the files it regenerates. */
export function readRegistry({ raw = false } = {}) {
  if (raw) return [...readList(HAND), ...readList(GENERATED)];
  const overrides = (() => { try { const { _, ...o } = JSON.parse(readFileSync(OVERRIDES, 'utf8')); return o; } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } })();
  return [...readList(HAND), ...readList(GENERATED)].map((c) => applyOverride(c, overrides[c.id]));
}

export function writeRegistry(list) {
  const hand = list.filter((c) => !c.generated);
  const generated = list.filter((c) => c.generated);
  writeFileSync(HAND, JSON.stringify(hand, null, 1) + '\n');
  writeFileSync(GENERATED, `[\n${generated.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`);
}
