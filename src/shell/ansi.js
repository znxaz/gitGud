// Colour helpers. Git ends a colour with ESC[m, so we do the same.
export function palette(on) {
  const w = code => s => (on && s !== '' ? `\x1b[${code}m${s}\x1b[m` : String(s));
  return {
    on,
    red: w('31'),
    green: w('32'),
    yellow: w('33'),
    blue: w('34'),
    magenta: w('35'),
    cyan: w('36'),
    bold: w('1'),
    dim: w('2'),
    boldRed: w('1;31'),
    boldGreen: w('1;32'),
    boldYellow: w('1;33'),
    boldBlue: w('1;34'),
    boldCyan: w('1;36'),
    redBg: w('41'),
    dir: s => (on ? `\x1b[01;34m${s}\x1b[0m` : s), // GNU ls style
  };
}

export const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
