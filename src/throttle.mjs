// `perClient(limit, windowMs)` stops one client monopolising something
// shared: beyond `limit` requests in the window it answers false (a 429).

export function perClient(limit, windowMs) {
  const hits = new Map(); // ip → [timestamps]
  let sweep = Date.now();
  return (ip) => {
    const now = Date.now();
    if (now - sweep > windowMs) { for (const [k, v] of hits) if (v[v.length - 1] < now - windowMs) hits.delete(k); sweep = now; }
    const list = (hits.get(ip) ?? []).filter((t) => t > now - windowMs);
    const ok = list.length < limit;
    if (ok) list.push(now); // a refused call doesn't stretch the refusal
    hits.set(ip, list);
    return ok;
  };
}
