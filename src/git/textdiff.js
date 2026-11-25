import { structuredPatch } from 'diff';
import { short, ZERO, readBlobBytes, plural } from './core.js';

const dec = new TextDecoder();
const isBinary = bytes => bytes && bytes.subarray(0, 8000).includes(0);

// Git's default rule for the text after @@: the nearest earlier line
// that starts with a letter, "_" or "$".
function funcContext(lines, hunkStart) {
  for (let i = hunkStart - 2; i >= 0; i--) {
    if (/^[A-Za-z_$]/.test(lines[i])) return lines[i].replace(/\s+$/, '').slice(0, 80);
  }
  return '';
}

function hunks(oldText, newText) {
  return structuredPatch('a', 'b', oldText, newText, '', '', { context: 3 }).hunks;
}

export function countLines(oldText, newText) {
  let add = 0, del = 0;
  for (const h of hunks(oldText, newText)) {
    for (const l of h.lines) {
      if (l[0] === '+') add++;
      else if (l[0] === '-') del++;
    }
  }
  return { add, del };
}

const range = (start, count) => {
  const s = count === 0 ? start - 1 : start;
  return count === 1 ? `${s}` : `${s},${count}`;
};

/**
 * One file's diff in Git's format.
 * a / b: { oid, mode, bytes } or null when the file is absent on that side.
 */
export function fileDiff(c, path, a, b) {
  const out = [];
  const meta = s => out.push(c.bold(s));
  meta(`diff --git a/${path} b/${path}`);
  const aOid = a ? a.oid : ZERO, bOid = b ? b.oid : ZERO;
  const mode = (b || a).mode.toString(8);
  if (!a) meta(`new file mode ${b.mode.toString(8)}`);
  else if (!b) meta(`deleted file mode ${a.mode.toString(8)}`);
  else if (a.mode !== b.mode) { meta(`old mode ${a.mode.toString(8)}`); meta(`new mode ${b.mode.toString(8)}`); }
  const sameMode = a && b && a.mode === b.mode;
  meta(`index ${short(aOid)}..${short(bOid)}${sameMode ? ' ' + mode : ''}`);
  const aBytes = a ? a.bytes : new Uint8Array();
  const bBytes = b ? b.bytes : new Uint8Array();
  if (isBinary(aBytes) || isBinary(bBytes)) {
    out.push(`Binary files ${a ? 'a/' + path : '/dev/null'} and ${b ? 'b/' + path : '/dev/null'} differ`);
    return out.join('\n') + '\n';
  }
  const oldText = dec.decode(aBytes), newText = dec.decode(bBytes);
  if (oldText === newText) return out.join('\n') + '\n';
  meta(`--- ${a ? 'a/' + path : '/dev/null'}`);
  meta(`+++ ${b ? 'b/' + path : '/dev/null'}`);
  const oldLines = oldText.split('\n');
  for (const h of hunks(oldText, newText)) {
    const fn = funcContext(oldLines, h.oldStart);
    out.push(c.cyan(`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`) + (fn ? ' ' + fn : ''));
    for (const l of h.lines) {
      if (l[0] === '+') {
        // Git marks trailing whitespace on added lines.
        const m = l.match(/^(.*?)([ \t]+)$/);
        out.push(m && c.on ? c.green(m[1]) + c.redBg(m[2]) : c.green(l));
      } else if (l[0] === '-') out.push(c.red(l));
      else out.push(l);
    }
  }
  return out.join('\n') + '\n';
}

export function isBinaryBytes(bytes) { return isBinary(bytes); }

/**
 * Compare two maps of path -> { oid, mode } and produce change records.
 * readA / readB load bytes for an entry.
 */
export async function changes(aMap, bMap, readA, readB) {
  const paths = [...new Set([...aMap.keys(), ...bMap.keys()])].sort();
  const out = [];
  for (const p of paths) {
    const a = aMap.get(p), b = bMap.get(p);
    if (a && b && a.oid === b.oid && a.mode === b.mode) continue;
    out.push({
      path: p,
      a: a ? { ...a, bytes: await readA(p, a) } : null,
      b: b ? { ...b, bytes: await readB(p, b) } : null,
    });
  }
  return out;
}

export const blobReader = repo => async (_p, e) => readBlobBytes(repo, e.oid);

// " index.html | 2 +-" lines followed by the summary, as merge and pull print them.
export function diffstat(c, list, cols = 80, { summaryOnly = false } = {}) {
  const rows = list.map(ch => {
    const bin = isBinary(ch.a?.bytes) || isBinary(ch.b?.bytes);
    if (bin) return { path: ch.path, bin: true, aSize: ch.a?.bytes.length || 0, bSize: ch.b?.bytes.length || 0, add: 0, del: 0 };
    const { add, del } = countLines(dec.decode(ch.a?.bytes || new Uint8Array()), dec.decode(ch.b?.bytes || new Uint8Array()));
    return { path: ch.path, add, del };
  });
  const lines = [];
  if (!summaryOnly && rows.length) {
    const nameW = Math.max(...rows.map(r => r.path.length));
    const maxChange = Math.max(...rows.map(r => r.add + r.del));
    const numW = Math.max(...rows.map(r => (r.bin ? 3 : String(r.add + r.del).length)));
    const graphW = Math.max(10, Math.min(cols, 80) - nameW - numW - 6);
    for (const r of rows) {
      if (r.bin) {
        lines.push(` ${r.path.padEnd(nameW)} | ${'Bin'.padStart(numW)} ${r.aSize} -> ${r.bSize} bytes`);
        continue;
      }
      let plus = r.add, minus = r.del;
      if (maxChange > graphW) {
        const scale = n => (n === 0 ? 0 : Math.max(1, Math.round((n * graphW) / maxChange)));
        plus = scale(r.add); minus = scale(r.del);
      }
      const graph = (plus ? c.green('+'.repeat(plus)) : '') + (minus ? c.red('-'.repeat(minus)) : '');
      lines.push(` ${r.path.padEnd(nameW)} | ${String(r.add + r.del).padStart(numW)}${graph ? ' ' + graph : ''}`);
    }
  }
  if (rows.length) {
    const ins = rows.reduce((s, r) => s + r.add, 0);
    const del = rows.reduce((s, r) => s + r.del, 0);
    let s = ` ${plural(rows.length, 'file')} changed`;
    if (!ins && !del) s += ', 0 insertions(+), 0 deletions(-)';
    else {
      if (ins) s += `, ${ins} insertion${ins === 1 ? '' : 's'}(+)`;
      if (del) s += `, ${del} deletion${del === 1 ? '' : 's'}(-)`;
    }
    lines.push(s);
  }
  // " create mode 100644 file" lines.
  for (const ch of list) {
    if (!ch.a && ch.b) lines.push(` create mode ${ch.b.mode.toString(8)} ${ch.path}`);
    else if (ch.a && !ch.b) lines.push(` delete mode ${ch.a.mode.toString(8)} ${ch.path}`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
