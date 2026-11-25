// Lay out names in columns, filled top to bottom, like ls.
export function columns(names, width, decorate = s => s) {
  if (!names.length) return '';
  const lens = names.map(n => n.length);
  for (let cols = Math.min(names.length, Math.floor(width / 3) || 1); cols >= 1; cols--) {
    const rows = Math.ceil(names.length / cols);
    const widths = [];
    for (let c = 0; c < cols; c++) {
      let w = 0;
      for (let r = 0; r < rows; r++) {
        const i = c * rows + r;
        if (i < names.length) w = Math.max(w, lens[i]);
      }
      widths.push(w);
    }
    const total = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2;
    if (total <= width || cols === 1) {
      const lines = [];
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          const i = c * rows + r;
          if (i >= names.length) continue;
          const isLast = c === cols - 1 || (c + 1) * rows + r >= names.length;
          line += decorate(names[i], i) + (isLast ? '' : ' '.repeat(widths[c] - lens[i] + 2));
        }
        lines.push(line);
      }
      return lines.join('\n');
    }
  }
  return names.join('  ');
}
