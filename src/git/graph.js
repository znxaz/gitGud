// Draws the ASCII graph used by git log --graph.

// Topological order, like --topo-order: a commit appears before its parents,
// and one line of history is shown before the next (last-in, first-out).
export function topoOrder(list) {
  const byOid = new Map(list.map(c => [c.oid, c]));
  const indeg = new Map(list.map(c => [c.oid, 0]));
  for (const c of list) for (const p of c.commit.parent) if (indeg.has(p)) indeg.set(p, indeg.get(p) + 1);
  const ready = list.filter(c => indeg.get(c.oid) === 0).reverse(); // newest on top of the stack
  const out = [];
  while (ready.length) {
    const c = ready.pop();
    out.push(c);
    for (const p of c.commit.parent) {
      if (!indeg.has(p)) continue;
      indeg.set(p, indeg.get(p) - 1);
      if (indeg.get(p) === 0) ready.push(byOid.get(p));
    }
  }
  return out;
}

const COLORS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
const BACKSLASH = String.fromCharCode(92);

/**
 * For each commit returns { first, connectors, cont }:
 *   first: graph text on the commit's own line
 *   connectors: extra graph lines ("|\", "|/") shown on the following lines
 *   cont: graph text for any further lines of that commit
 * Column i is drawn at character position 2*i; diagonal lines sit between columns.
 */
export function graphRows(list, c) {
  const paint = (ch, col) => {
    if (ch === ' ' || ch === '*') return ch;
    const fn = c[COLORS[((col % COLORS.length) + COLORS.length) % COLORS.length]];
    return fn ? fn(ch) : ch;
  };
  // marks: array of [position, char, colourIndex]
  const draw = (marks, width) => {
    const chars = Array(width).fill(' ');
    const colors = Array(width).fill(0);
    for (const [pos, ch, col] of marks) { chars[pos] = ch; colors[pos] = col; }
    return chars.map((ch, i) => paint(ch, colors[i])).join('');
  };

  let cols = [];
  const rows = [];
  for (const item of list) {
    let idx = cols.indexOf(item.oid);
    if (idx < 0) { cols.push(item.oid); idx = cols.length - 1; }
    const parents = item.commit.parent;
    const before = cols.length;

    let next = cols.slice();
    const added = [];
    if (!parents.length) next.splice(idx, 1);
    else {
      next[idx] = parents[0];
      let at = idx + 1;
      for (const p of parents.slice(1)) {
        if (!next.includes(p)) { next.splice(at, 0, p); added.push(at); at++; }
      }
    }
    const width = Math.max(before, next.length, 1) * 2;

    // The commit's own line: "*" in its column, "|" for the others.
    const first = draw(cols.map((_, i) => [2 * i, i === idx ? '*' : '|', i]), width);

    const connectors = [];
    if (added.length) {
      const marks = [];
      for (let i = 0; i <= idx; i++) marks.push([2 * i, '|', i]);
      for (let i = idx + 1; i < next.length; i++) marks.push([2 * i - 1, BACKSLASH, i]);
      connectors.push(draw(marks, width));
    }
    // Two columns waiting for the same commit join into one.
    const seen = new Set();
    const dup = [];
    next.forEach((oid, i) => { if (seen.has(oid)) dup.push(i); else seen.add(oid); });
    if (dup.length) {
      const marks = [];
      for (let i = 0; i < next.length; i++) marks.push(i < dup[0] ? [2 * i, '|', i] : [2 * i - 1, '/', i]);
      connectors.push(draw(marks, width));
      next = next.filter((_, i) => !dup.includes(i));
    }
    if (!parents.length && idx < before - 1) {
      const marks = [];
      for (let i = 0; i < before; i++) {
        if (i < idx) marks.push([2 * i, '|', i]);
        else if (i > idx) marks.push([2 * i - 1, '/', i]);
      }
      connectors.push(draw(marks, width));
    }
    cols = next;
    const cont = draw(cols.map((_, i) => [2 * i, '|', i]), width);
    rows.push({ first, connectors, cont });
  }
  return rows;
}
