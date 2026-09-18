// A minimal OpenStreetMap PBF reader: just enough protobuf to stream the
// nodes and ways out of a Geofabrik extract. No dependencies — node's zlib
// does the decompression and the wire format is only varints and bytes.
//
//   for await (const block of blocks(path)) block.nodes(...) / block.ways(...)
//
// Ids and coordinates are decoded as plain numbers: OSM ids are well inside
// 2^53 and the delta-coded lat/lon sums are too.

import { open } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

// ---------- protobuf wire format ----------

class Reader {
  constructor(buf, start = 0, end = buf.length) { this.buf = buf; this.pos = start; this.end = end; }
  get done() { return this.pos >= this.end; }
  varint() {
    // Up to 10 bytes; use multiplication past bit 28 so we do not overflow int32.
    let x = 0, mul = 1, b;
    do {
      b = this.buf[this.pos++];
      x += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return x;
  }
  svarint() {
    // Zigzag: even → n/2, odd → -(n+1)/2. Done with arithmetic, not shifts.
    const n = this.varint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }
  /** Read a field tag; returns [fieldNumber, wireType]. */
  tag() { const t = this.varint(); return [Math.floor(t / 8), t & 7]; }
  bytes() { const len = this.varint(); const r = new Reader(this.buf, this.pos, this.pos + len); this.pos += len; return r; }
  slice() { const len = this.varint(); const s = this.buf.subarray(this.pos, this.pos + len); this.pos += len; return s; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) { const len = this.varint(); this.pos += len; } // two steps: += would read pos before varint() moves it
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  /** Packed repeated varints (protobuf packs them into one length-delimited field). */
  packed(signed = false) {
    const r = this.bytes(); const out = [];
    while (!r.done) out.push(signed ? r.svarint() : r.varint());
    return out;
  }
}

// ---------- OSM PBF structure ----------

function readBlobHeader(r) {
  let type = '', datasize = 0;
  while (!r.done) {
    const [f, w] = r.tag();
    if (f === 1) type = r.slice().toString();
    else if (f === 3) datasize = r.varint();
    else r.skip(w);
  }
  return { type, datasize };
}

function readBlob(r) {
  let raw = null, zlib = null;
  while (!r.done) {
    const [f, w] = r.tag();
    if (f === 1) raw = r.slice();
    else if (f === 3) zlib = r.slice();
    else r.skip(w);
  }
  if (raw) return raw;
  if (zlib) return inflateSync(zlib);
  throw new Error('blob uses a compression this reader does not support (only zlib)');
}

/** One decoded PrimitiveBlock: iterate its nodes and ways lazily. */
class Block {
  constructor(buf) {
    this.strings = [];
    this.groups = [];
    this.granularity = 100; this.latOffset = 0; this.lonOffset = 0;
    const r = new Reader(buf);
    while (!r.done) {
      const [f, w] = r.tag();
      if (f === 1) { const s = r.bytes(); while (!s.done) { const [sf, sw] = s.tag(); if (sf === 1) this.strings.push(s.slice().toString()); else s.skip(sw); } }
      else if (f === 2) this.groups.push(r.bytes());
      else if (f === 17) this.granularity = r.varint();
      else if (f === 19) this.latOffset = r.varint();
      else if (f === 20) this.lonOffset = r.varint();
      else r.skip(w);
    }
  }
  coord(latRaw, lonRaw) {
    return {
      lat: 1e-9 * (this.latOffset + this.granularity * latRaw),
      lon: 1e-9 * (this.lonOffset + this.granularity * lonRaw),
    };
  }
  tags(keys, vals) {
    if (!keys.length) return null;
    const t = {};
    for (let i = 0; i < keys.length; i++) t[this.strings[keys[i]]] = this.strings[vals[i]];
    return t;
  }

  /** Call fn(id, lat, lon, tags|null) for every node in the block. */
  nodes(fn) {
    for (const g of this.groups) {
      const r = new Reader(g.buf, g.pos, g.end);
      while (!r.done) {
        const [f, w] = r.tag();
        if (f === 2) this.dense(r.bytes(), fn);
        else if (f === 1) this.node(r.bytes(), fn);
        else r.skip(w);
      }
    }
  }
  node(r, fn) {
    let id = 0, lat = 0, lon = 0, keys = [], vals = [];
    while (!r.done) {
      const [f, w] = r.tag();
      if (f === 1) id = r.svarint();
      else if (f === 2) keys = r.packed();
      else if (f === 3) vals = r.packed();
      else if (f === 8) lat = r.svarint();
      else if (f === 9) lon = r.svarint();
      else r.skip(w);
    }
    const c = this.coord(lat, lon);
    fn(id, c.lat, c.lon, this.tags(keys, vals));
  }
  dense(r, fn) {
    let ids = [], lats = [], lons = [], kv = [];
    while (!r.done) {
      const [f, w] = r.tag();
      if (f === 1) ids = r.packed(true);
      else if (f === 8) lats = r.packed(true);
      else if (f === 9) lons = r.packed(true);
      else if (f === 10) kv = r.packed();
      else r.skip(w);
    }
    let id = 0, lat = 0, lon = 0, k = 0;
    for (let i = 0; i < ids.length; i++) {
      id += ids[i]; lat += lats[i]; lon += lons[i];
      let tags = null;
      if (kv.length) {
        while (kv[k] !== 0) {
          (tags ??= {})[this.strings[kv[k]]] = this.strings[kv[k + 1]];
          k += 2;
        }
        k++;
      }
      const c = this.coord(lat, lon);
      fn(id, c.lat, c.lon, tags);
    }
  }

  /** Call fn(id, refs, tags|null) for every way in the block. */
  ways(fn) {
    for (const g of this.groups) {
      const r = new Reader(g.buf, g.pos, g.end);
      while (!r.done) {
        const [f, w] = r.tag();
        if (f !== 3) { r.skip(w); continue; }
        const wr = r.bytes();
        let id = 0, keys = [], vals = [], refs = [];
        while (!wr.done) {
          const [wf, ww] = wr.tag();
          if (wf === 1) id = wr.varint();
          else if (wf === 2) keys = wr.packed();
          else if (wf === 3) vals = wr.packed();
          else if (wf === 8) { refs = wr.packed(true); for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1]; }
          else wr.skip(ww);
        }
        fn(id, refs, this.tags(keys, vals));
      }
    }
  }
}

/**
 * Stream the data blocks of a PBF file. Each yielded item is
 * { offset, block } where block is a Block (decoded lazily per call).
 * Pass `only` (a Set of byte offsets) to decode just those blobs, skipping
 * the rest without decompressing them.
 */
export async function* blocks(path, { only = null, onProgress = null } = {}) {
  const fh = await open(path, 'r');
  const { size } = await fh.stat();
  const head = Buffer.alloc(4);
  let offset = 0;
  try {
    while (offset < size) {
      await fh.read(head, 0, 4, offset);
      const headerLen = head.readUInt32BE(0);
      const header = Buffer.alloc(headerLen);
      await fh.read(header, 0, headerLen, offset + 4);
      const { type, datasize } = readBlobHeader(new Reader(header));
      const blobStart = offset + 4 + headerLen;
      const thisOffset = offset;
      offset = blobStart + datasize;
      if (type !== 'OSMData' || (only && !only.has(thisOffset))) continue;
      const blob = Buffer.alloc(datasize);
      await fh.read(blob, 0, datasize, blobStart);
      yield { offset: thisOffset, block: new Block(readBlob(new Reader(blob))) };
      onProgress?.(offset / size);
    }
  } finally {
    await fh.close();
  }
}
