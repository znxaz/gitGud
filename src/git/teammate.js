import git from 'isomorphic-git';
import { fs, REMOTE } from '../vfs.js';
import { now, treeFiles, readBlobText, short } from './core.js';

const remote = () => ({ fs, gitdir: REMOTE, cache: {} });

export async function remoteMainOid() {
  try { return await git.resolveRef({ ...remote(), ref: 'refs/heads/main' }); } catch { return null; }
}

const FOOTERS = [
  'Made by the CS lab group. Updated by the team.',
  'Made by the CS lab group. Contact: lab-group@example.com',
];

/**
 * A teammate commits straight to the remote: they edit the footer line of
 * index.html on origin's main branch. Nothing in the learner's repository changes.
 */
export async function teammateCommit(previousCount) {
  const r = remote();
  const tip = await remoteMainOid();
  if (!tip) return { ok: false, reason: 'The remote has no commits on main yet.' };
  const files = await treeFiles({ gitdir: REMOTE, cache: r.cache }, tip);

  let path = 'index.html';
  let text = files.has(path) ? await readBlobText({ gitdir: REMOTE, cache: r.cache }, files.get(path).oid) : null;
  const footerText = FOOTERS[previousCount] || `Made by the CS lab group. Version ${previousCount + 1}.`;
  let what;
  if (text !== null) {
    const lines = text.split('\n');
    let i = lines.findIndex(l => /<footer[\s>]/i.test(l));
    if (i >= 0) {
      const indent = lines[i].match(/^\s*/)[0];
      lines[i] = `${indent}<footer>${footerText}</footer>`;
      what = 'the footer line in index.html';
    } else {
      i = lines.findIndex(l => /<\/body>/i.test(l));
      const at = i >= 0 ? i : lines.length;
      lines.splice(at, 0, `  <footer>${footerText}</footer>`);
      what = 'a footer line in index.html';
    }
    text = lines.join('\n');
  } else {
    path = 'TEAM.md';
    text = `# Team notes\n\n${footerText}\n`;
    what = 'TEAM.md';
  }

  const blob = await git.writeBlob({ ...r, blob: new TextEncoder().encode(text) });
  // Rebuild the root tree with the one changed entry.
  const { tree } = await git.readTree({ ...r, oid: tip });
  const entries = tree.filter(e => e.path !== path);
  entries.push({ mode: '100644', path, oid: blob, type: 'blob' });
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const treeOid = await git.writeTree({ ...r, tree: entries });
  const author = { name: 'Teammate', email: 'teammate@example.com', ...now() };
  const oid = await git.commit({
    ...r,
    ref: 'refs/heads/main',
    tree: treeOid,
    parent: [tip],
    message: 'Update the footer text\n',
    author,
    committer: author,
  });
  return { ok: true, oid, short: short(oid), what };
}
