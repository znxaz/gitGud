import { Exit } from './core.js';
import { init, config, status, add, rm, commit } from './basic.js';
import { log, show, diff } from './history.js';
import { branch, switchCmd, checkout, restore, merge } from './branching.js';
import { remoteCmd, fetch, pull, push, clone } from './remote.js';
import gitPkg from 'isomorphic-git';

const COMMANDS = {
  init, config, status, add, rm, commit, log, show, diff,
  branch, switch: switchCmd, checkout, restore, merge,
  remote: remoteCmd, fetch, pull, push, clone,
};

// Real Git commands that this lab does not include.
const NOT_IN_LAB = ['stash', 'rebase', 'reset', 'revert', 'tag', 'cherry-pick', 'mv', 'bisect', 'blame',
  'reflog', 'clean', 'submodule', 'worktree', 'gc', 'grep', 'shortlog', 'describe', 'am', 'apply',
  'format-patch', 'notes', 'archive', 'bundle', 'fsck', 'prune', 'rev-parse', 'ls-files', 'cat-file'];

export const GIT_SUBCOMMANDS = Object.keys(COMMANDS).sort();

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

const HELP = `usage: git [-v | --version] [-h | --help] <command> [<args>]

Commands in this lab:

start a working area
   clone      Clone a repository into a new directory
   init       Create an empty Git repository or reinitialize an existing one

work on the current change
   add        Add file contents to the index
   restore    Restore working tree files
   rm         Remove files from the working tree and from the index

examine the history and state
   diff       Show changes between commits, commit and working tree, etc
   log        Show commit logs
   show       Show various types of objects
   status     Show the working tree status

grow, mark and tweak your common history
   branch     List, create, or delete branches
   commit     Record changes to the repository
   merge      Join two or more development histories together
   switch     Switch branches

collaborate
   fetch      Download objects and refs from another repository
   pull       Fetch from and integrate with another repository or a local branch
   push       Update remote refs along with associated objects
   remote     Manage set of tracked repositories

settings
   config     Get and set repository or global options
`;

export async function runGit(ctx, args) {
  // Global options before the subcommand.
  while (args.length && args[0].startsWith('-')) {
    const a = args.shift();
    if (a === '--version' || a === '-v') { ctx.out.write(`git version isomorphic-git ${gitPkg.version()}\n`); return 0; }
    if (a === '--help' || a === '-h') { ctx.out.write(HELP); return 0; }
    if (a === '-C') {
      const dir = args.shift();
      ctx = { ...ctx, cwd: dir.startsWith('/') ? dir : ctx.cwd + '/' + dir };
      continue;
    }
    if (a === '--no-pager' || a === '-P' || a === '--paginate' || a === '-p') continue;
    ctx.err.write(`unknown option: ${a}\n${HELP.split('\n')[0]}\n`);
    return 129;
  }
  if (!args.length) { ctx.out.write(HELP); return 1; }
  const sub = args.shift();
  if (sub === 'help') { ctx.out.write(HELP); return 0; }
  const fn = COMMANDS[sub];
  if (!fn) {
    if (NOT_IN_LAB.includes(sub)) {
      ctx.err.write(`gitGud: git ${sub} is not available in this lab.\n`);
      return 1;
    }
    ctx.err.write(`git: '${sub}' is not a git command. See 'git --help'.\n`);
    const close = GIT_SUBCOMMANDS.map(c => [c, levenshtein(sub, c)]).filter(([, d]) => d <= 2).sort((x, y) => x[1] - y[1]);
    if (close.length) {
      const best = close.filter(([, d]) => d === close[0][1]).map(([c]) => c);
      ctx.err.write(`\nThe most similar command${best.length > 1 ? 's are' : ' is'}\n${best.map(c => '\t' + c).join('\n')}\n`);
    }
    return 1;
  }
  try {
    const code = await fn(ctx, args);
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    if (err instanceof Exit) return err.code;
    throw err;
  }
}
