// "Was this right?" — what people at the crossing actually saw, kept next to
// what we predicted at that moment. This is the calibration data the run
// times and closeBeforeSec will be tuned from. Each report is one JSON line
// in data/feedback.jsonl, echoed to the log, and posted to FEEDBACK_WEBHOOK
// if set (for hosts whose disk does not survive a restart).
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, '..', 'data', 'feedback.jsonl');
const WEBHOOK = process.env.FEEDBACK_WEBHOOK || '';

const OBSERVED = new Set(['down', 'up']);
const PREDICTED = new Set(['open', 'soon', 'closed']);

/** Shape-check a report from the page; returns the clean record or null. */
export function cleanReport(body, crossing, now = Date.now()) {
  if (!body || typeof body !== 'object' || !crossing) return null;
  if (!OBSERVED.has(body.observed) || !PREDICTED.has(body.predicted)) return null;
  const num = (x) => (Number.isFinite(x) ? Math.round(x) : null);
  return {
    at: new Date(now).toISOString(),
    crossing: crossing.id,
    observed: body.observed,              // what they saw: barriers down / up
    predicted: body.predicted,            // what the page said: open / soon / closed
    predictedAt: num(body.predictedAt),   // the closure edge the page was counting to (ms epoch)
    closeAt: num(body.closeAt),           // the closure that was current or next…
    openAt: num(body.openAt),             // …so the error can be measured later
    dataAge: num(body.dataAge),           // ms since the page last refreshed
    live: !!body.live,
    ua: String(body.ua ?? '').slice(0, 120),
  };
}

// One report per crossing per client every 30 s is plenty; anything faster
// is a stuck finger or a script.
const recent = new Map();
export function tooSoon(key, now = Date.now()) {
  const last = recent.get(key) ?? 0;
  if (now - last < 30_000) return true;
  recent.set(key, now);
  if (recent.size > 5000) for (const [k, t] of recent) if (now - t > 60_000) recent.delete(k);
  return false;
}

export async function record(report) {
  const line = JSON.stringify(report);
  console.log('feedback', line);
  try {
    await mkdir(path.dirname(FILE), { recursive: true });
    await appendFile(FILE, line + '\n');
  } catch (e) {
    console.warn('feedback: could not write file', e.message);
  }
  if (WEBHOOK) {
    fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: line, signal: AbortSignal.timeout(5000) })
      .catch((e) => console.warn('feedback: webhook failed', e.message));
  }
}
