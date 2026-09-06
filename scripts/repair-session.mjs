#!/usr/bin/env node
// One-off session repair tool (scripts/repair-session.mjs) — v3, frame-preserving.
//
// Fixes SessionPersistenceCorruptionError "session event at seq N lacks an
// identified message": heartbeat deliveries once spliced hand-rolled messages
// (no message id) into a bound session's log; the persistence validator
// rejects them at load.
//
// Host storage invariant (dsh-session-persistence-jsonl): the log is MULTI-
// FRAME zstd, and the FIRST frame must decode to exactly one line — the
// session header. v2 of this tool rewrote everything into a single frame and
// broke that invariant ("first frame is not exactly one header line"). v3 is
// FRAME-PRESERVING: only the frame containing a corrupt event is decoded,
// fixed, and recompressed; every other frame is kept byte-identical.
//
// Usage:
//   node scripts/repair-session.mjs inspect <session-dir>
//   node scripts/repair-session.mjs fix     <session-dir>
// Close DSH before running `fix` on a session the host may flush.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';

const [mode, sessionDir] = process.argv.slice(2);
if (!mode || !sessionDir || !['inspect', 'fix'].includes(mode)) {
  console.error('usage: node scripts/repair-session.mjs inspect|fix <session-dir>');
  process.exit(1);
}

const zstdPath = path.join(sessionDir, 'session.jsonl.zstd');
const buf = fs.readFileSync(zstdPath);

/** Split a multi-frame zstd buffer into frame slices on the magic bytes. */
function splitFrames(buffer) {
  const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
  const starts = [];
  for (let i = 0; i <= buffer.length - 4; i++) {
    if (buffer[i] === magic[0] && buffer[i + 1] === magic[1] && buffer[i + 2] === magic[2] && buffer[i + 3] === magic[3]) {
      starts.push(i);
    }
  }
  if (starts.length === 0) return [buffer];
  const slices = [];
  for (let i = 0; i < starts.length; i++) {
    slices.push(buffer.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : buffer.length));
  }
  return slices;
}

/** Decompress frame slices, merging slices that fail alone (false splits). */
function decompressFrames(slices) {
  const chunks = [];
  let pending = null;
  for (const slice of slices) {
    const chunk = pending ? Buffer.concat([pending, slice]) : slice;
    try {
      chunks.push(zlib.zstdDecompressSync(chunk));
      pending = null;
    } catch {
      pending = chunk; // false split or trailing garbage: merge forward
    }
  }
  if (pending) {
    chunks.push(zlib.zstdDecompressSync(pending));
  }
  return chunks;
}

// ── decode all frames into chunks {text, frameIdxs} ─────────────────────
const frameSlices = splitFrames(buf);
const chunks = [];
{
  let pending = null;
  let pendingIdxs = [];
  frameSlices.forEach((slice, i) => {
    const chunk = pending ? Buffer.concat([pending, slice]) : slice;
    const idxs = pending ? [...pendingIdxs, i] : [i];
    try {
      chunks.push({ text: zlib.zstdDecompressSync(chunk).toString('utf8'), frameIdxs: idxs, original: chunk });
      pending = null;
      pendingIdxs = [];
    } catch {
      pending = chunk;
      pendingIdxs = idxs;
    }
  });
  if (pending) {
    chunks.push({ text: zlib.zstdDecompressSync(pending).toString('utf8'), frameIdxs: pendingIdxs, original: pending });
  }
}

// Invariant check: the first frame must decode to exactly one header line.
if (!chunks[0] || chunks[0].frameIdxs[0] !== 0) {
  console.error('ABORT: first frame chunk missing or misaligned.');
  process.exit(1);
}
const firstLines = chunks[0].text.split('\n').filter((l) => l.trim());
if (firstLines.length !== 1) {
  console.error(`ABORT: first frame decodes to ${firstLines.length} lines (expected 1 header line).`);
  console.error('The file does not match the host storage invariant — refusing to touch it.');
  process.exit(1);
}

// ── scan + fix (precise corrupt signature: our hand-rolled deliveries) ──
const NEEDS = { type: 'user/message', plugin: 'heartbeat' };
let scanned = 0;
const corrupt = [];
let totalChanges = 0;

const newChunks = chunks.map((chunk) => {
  const lines = chunk.text.split('\n');
  let changed = false;
  const out = lines.map((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return line;
    }
    scanned += 1;
    if (
      obj.type === NEEDS.type &&
      obj.data && typeof obj.data === 'object' &&
      obj.data.source && obj.data.source.kind === 'plugin' && obj.data.source.plugin === NEEDS.plugin &&
      !obj.data.id
    ) {
      corrupt.push({ chunkLine: idx, preview: JSON.stringify(obj.data).slice(0, 120) });
      if (mode === 'fix') {
        obj.data.id = randomUUID();
        changed = true;
        totalChanges += 1;
        return JSON.stringify(obj);
      }
    }
    return line;
  });
  if (!changed) return { ...chunk, text: chunk.text };
  return { ...chunk, text: out.join('\n'), changed };
});

console.log(`frames: ${frameSlices.length} | scanned ${scanned} events; corrupt (our delivery, missing id): ${corrupt.length}`);
for (const c of corrupt.slice(0, 10)) console.log(`  ${c.preview}`);
if (corrupt.length > 10) console.log(`  ... and ${corrupt.length - 10} more`);

if (mode === 'fix') {
  if (totalChanges === 0) {
    console.log('nothing to fix.');
    process.exit(0);
  }
  const backup = zstdPath + '.bak-' + Date.now();
  fs.copyFileSync(zstdPath, backup);
  console.log('backup written:', backup);

  // Reassemble: changed chunks recompressed; unchanged chunks BYTE-IDENTICAL.
  const parts = [];
  for (const chunk of newChunks) {
    if (!chunk.changed) {
      parts.push(chunk.original);
      continue;
    }
    parts.push(zlib.zstdCompressSync(Buffer.from(chunk.text, 'utf8')));
  }
  fs.writeFileSync(zstdPath, Buffer.concat(parts));

  // Post-fix verification: re-read, first frame still = 1 header line,
  // and no corrupt events remain.
  const verify = splitFrames(fs.readFileSync(zstdPath));
  const verifyFrames = splitFrames(fs.readFileSync(zstdPath));
  const firstDecoded = zlib.zstdDecompressSync(verifyFrames[0]).toString('utf8').split('\n').filter((l) => l.trim());
  const stillCorrupt = (() => {
    for (const f of verify) {
      const t = zlib.zstdDecompressSync(f).toString('utf8');
      for (const line of t.split('\n')) {
        try {
          const o = JSON.parse(line);
          if (o.type === 'user/message' && o.data?.source?.plugin === 'heartbeat' && !o.data.id) return true;
        } catch { /* skip */ }
      }
    }
    return false;
  })();
  console.log(`verify: first frame lines = ${firstDecoded.length} (must be 1) | still corrupt = ${stillCorrupt}`);
  if (firstDecoded.length !== 1 || stillCorrupt) {
    console.error('VERIFICATION FAILED — restore from backup:', backup);
    process.exit(1);
  }
  console.log(`FIXED: ${totalChanges} event(s) repaired. Restart DSH and reopen the session.`);
}
