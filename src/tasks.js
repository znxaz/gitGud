import git from 'isomorphic-git';
import { fs, pfs, PROJECT, REMOTE, readText, exists, join, isDir, SEED_FILES } from './vfs.js';
import {
  repoAt, base, headOid, currentBranch, branchOid, listBranches, commitCount, computeStatus,
  getConfig, treeFiles, readBlobText, isAncestor, revList, mergeHead, short, plural,
} from './git/core.js';

const repo = () => repoAt(PROJECT);
const isRepo = () => isDir(PROJECT + '/.git');

async function fileAt(oid, path) {
  const files = await treeFiles(repo(), oid);
  const e = files.get(path);
  return e ? readBlobText(repo(), e.oid) : null;
}

const h1 = html => (html && (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '').trim();
const noStop = s => s.replace(/[.!?]+$/, '');
const tagline = html => (html && (html.match(/<p class="tagline"[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '').trim();
// The <header> block with whitespace evened out, so re-indenting alone does not count as a change.
const headerBlock = html => (html && (html.match(/<header[^>]*>([\s\S]*?)<\/header>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();

async function remoteMain() {
  try { return await git.resolveRef({ fs, gitdir: REMOTE, ref: 'refs/heads/main' }); } catch { return null; }
}

async function remoteCount() {
  const tip = await remoteMain();
  return tip ? (await revList({ gitdir: REMOTE, cache: {} }, [tip])).length : 0;
}

const files = n => plural(n, 'file');

/**
 * Each task: id, title, text (instruction), commands (the quiet strip), check.
 * check(t) returns the confirmation line when the task is done, or null.
 * t.seen(kind, test) is true when Git displayed that kind of output after the task started.
 */
export const TASKS = [
  {
    id: 'config',
    title: 'Set your name and email',
    text: 'Set your name and your email in the Git config. Git writes them into every commit.',
    commands: ['git config'],
    async check() {
      const r = (await isRepo()) ? repo() : null;
      const name = await getConfig(r, 'user.name');
      const email = await getConfig(r, 'user.email');
      if (!name || !email) return null;
      return `Identity set: ${name} <${email}>.`;
    },
  },
  {
    id: 'init',
    title: 'Turn the folder into a repository',
    text: 'Make /project a Git repository.',
    commands: ['pwd', 'ls -a', 'git init'],
    async check() {
      if (!(await isRepo())) return null;
      return '/project is now a repository. It has 0 commits.';
    },
  },
  {
    id: 'status',
    title: 'Run git status and read it',
    text: 'Show the status of the repository. Read each heading.',
    commands: ['git status'],
    async check(t) {
      if (!(await isRepo()) || !t.seen('status')) return null;
      const st = await computeStatus(repo());
      return `${files(st.untracked.length)} untracked, ${st.staged.length} staged, ${st.unstaged.length} modified.`;
    },
  },
  {
    id: 'stage',
    title: 'Stage every file',
    text: 'Stage every file in the project.',
    commands: ['git status', 'git add'],
    async check() {
      if (!(await isRepo())) return null;
      const st = await computeStatus(repo());
      if (st.untracked.length || st.unstaged.length) return null;
      if (st.staged.length) return `${files(st.staged.length)} staged, 0 unstaged.`;
      // Already staged and committed everything.
      const head = await headOid(repo());
      if (!head) return null;
      return `${files((await treeFiles(repo(), head)).size)} tracked, 0 untracked.`;
    },
  },
  {
    id: 'first-commit',
    title: 'Make your first commit',
    text: 'Commit the staged files. Write a short message that says what the commit contains.',
    commands: ['git status', 'git commit'],
    async check() {
      if (!(await isRepo())) return null;
      const n = await commitCount(repo(), await headOid(repo()));
      if (n < 1) return null;
      return `Repository now has ${plural(n, 'commit')}.`;
    },
  },
  {
    id: 'heading',
    title: 'Change the header and commit it',
    text: 'Open index.html. Find these 2 lines near the top:',
    code: '<h1>Study Planner</h1>\n<p class="tagline">Plan your week. Add a task, then mark it done.</p>',
    after: 'Change the text in one of them, or add your own line of HTML between them. Then stage index.html and commit it.',
    commands: ['git status', 'git add', 'git commit'],
    async check() {
      const head = await headOid(repo());
      if (!head) return null;
      if ((await commitCount(repo(), head)) < 2) return null;
      const html = await fileAt(head, 'index.html');
      if (html === null) return null;
      const seed = SEED_FILES['index.html'];
      if (headerBlock(html) === headerBlock(seed)) return null;
      if (h1(html) && h1(html) !== h1(seed)) return `Commit ${short(head)} has the new heading: ${noStop(h1(html))}.`;
      if (tagline(html) && tagline(html) !== tagline(seed)) return `Commit ${short(head)} has the new tagline: ${noStop(tagline(html))}.`;
      return `Commit ${short(head)} changes the header in index.html.`;
    },
  },
  {
    id: 'three-commits',
    title: 'Get to 3 commits',
    text: 'Make more changes and commit them until the history has 3 commits.',
    commands: ['git add', 'git commit', 'git log'],
    async check() {
      const n = await commitCount(repo(), await headOid(repo()));
      if (n < 3) return null;
      return `${plural(n, 'commit')}. Your history is building.`;
    },
  },
  {
    id: 'oneline',
    title: 'View your history, 1 line per commit',
    text: 'Show the history with 1 line for each commit.',
    commands: ['git log'],
    async check(t) {
      const seen = t.last('log', d => d.oneline);
      if (!seen) return null;
      return `${plural(seen.count, 'commit')} listed, newest first.`;
    },
  },
  {
    id: 'show',
    title: 'Look at what your last commit changed',
    text: 'Show the most recent commit and the changes it made.',
    commands: ['git log', 'git show'],
    async check(t) {
      const head = await headOid(repo());
      const seen = t.last('show', d => d.oid === head) || t.last('log', d => d.patch && d.head === head);
      if (!seen) return null;
      const list = seen.files || [];
      return list.length ? `Commit ${short(head)} changed ${list.join(', ')}.` : `Commit ${short(head)} is shown with its changes.`;
    },
  },
  {
    id: 'diff',
    title: 'See a change before staging it',
    text: 'Change a tracked file. Before you stage it, show exactly what changed.',
    commands: ['git status', 'git diff'],
    async check(t) {
      const seen = t.last('diff', d => d.unstaged && !d.empty);
      if (!seen) return null;
      return `${files(seen.files.length)} modified, not staged. git diff compared ${seen.files.length === 1 ? 'it' : 'them'} with the staging area.`;
    },
  },
  {
    id: 'diff-staged',
    title: 'See a staged change',
    text: 'Stage the change. Then show what the next commit will contain.',
    commands: ['git add', 'git diff'],
    async check(t) {
      const seen = t.last('diff', d => d.staged && !d.empty);
      if (!seen) return null;
      return `${files(seen.files.length)} staged. This is what the next commit will contain.`;
    },
  },
  {
    id: 'commit-it',
    title: 'Commit it',
    text: 'Commit the staged change.',
    commands: ['git status', 'git commit'],
    async check(t) {
      const head = await headOid(repo());
      if (!head || head === t.start.head) return null;
      const st = await computeStatus(repo());
      if (st.staged.length) return null;
      return `Repository now has ${plural(await commitCount(repo(), head), 'commit')}. The staging area is empty.`;
    },
  },
  {
    id: 'ignore',
    title: 'Ignore secret.env',
    text: 'Create a file with this name:',
    code: 'secret.env',
    after: 'Write a .gitignore so Git stops listing it as untracked. Then commit the .gitignore file.',
    commands: ['touch', 'echo', 'git status', 'git commit'],
    async check() {
      const r = repo();
      if (!(await exists(join(PROJECT, 'secret.env')))) return null;
      if (!(await git.isIgnored({ ...base(r), filepath: 'secret.env' }))) return null;
      const head = await headOid(r);
      const committed = await fileAt(head, '.gitignore');
      if (committed === null) return null;
      let work = null;
      try { work = await readText(join(PROJECT, '.gitignore')); } catch { /* missing */ }
      if (work !== committed) return null;
      if ((await treeFiles(r, head)).has('secret.env')) return null;
      return `secret.env is ignored. .gitignore is in commit ${short(head)}.`;
    },
  },
  {
    id: 'which-branch',
    title: 'Find out which branch you are on',
    text: 'Show the list of branches. The current branch is marked.',
    commands: ['git branch', 'git status'],
    async check(t) {
      const seen = t.last('branch') || t.last('status');
      if (!seen) return null;
      const b = await currentBranch(repo());
      return `Current branch: ${b}.`;
    },
  },
  {
    id: 'create-branch',
    title: 'Create dark-mode and switch to it',
    text: 'Create a branch called dark-mode. Switch to it.',
    commands: ['git branch', 'git switch'],
    async check(t) {
      if ((await currentBranch(repo())) !== 'dark-mode') return null;
      const main = t.progress.mainBranch || 'main';
      const a = await branchOid(repo(), 'dark-mode');
      const b = await branchOid(repo(), main);
      return a === b ? `On branch dark-mode. It points to the same commit as ${main}: ${short(a)}.` : 'On branch dark-mode.';
    },
  },
  {
    id: 'branch-commit',
    title: 'Commit a change to style.css on dark-mode',
    text: 'Change style.css. Commit the change on the dark-mode branch.',
    commands: ['git status', 'git add', 'git commit'],
    async check(t) {
      const main = t.progress.mainBranch || 'main';
      const dark = await branchOid(repo(), 'dark-mode');
      const mainOid = await branchOid(repo(), main);
      if (!dark || !mainOid || dark === mainOid) return null;
      if (!(await isAncestor(repo(), mainOid, dark))) return null;
      const a = await fileAt(dark, 'style.css'), b = await fileAt(mainOid, 'style.css');
      if (a === b) return null;
      t.progress.darkTip = dark;
      const ahead = (await revList(repo(), [dark], { exclude: [mainOid] })).length;
      return `dark-mode is ${plural(ahead, 'commit')} ahead of ${main}.`;
    },
  },
  {
    id: 'switch-back',
    title: 'Switch back and check style.css',
    text: 'Switch back to your main branch. Open style.css and check that the change is gone.',
    commands: ['git switch', 'cat', 'git branch'],
    async check(t) {
      const main = t.progress.mainBranch || 'main';
      if ((await currentBranch(repo())) !== main) return null;
      const mainOid = await branchOid(repo(), main);
      const onMain = await fileAt(mainOid, 'style.css');
      let work = null;
      try { work = await readText(join(PROJECT, 'style.css')); } catch { return null; }
      const dark = await branchOid(repo(), 'dark-mode');
      if (work !== onMain || !dark || (await fileAt(dark, 'style.css')) === onMain) return null;
      return `style.css is back to the version on ${main}.`;
    },
  },
  {
    id: 'merge',
    title: 'Merge dark-mode into your main branch',
    text: 'On your main branch, merge dark-mode.',
    commands: ['git merge', 'git log'],
    async check(t) {
      const main = t.progress.mainBranch || 'main';
      const mainOid = await branchOid(repo(), main);
      const dark = (await branchOid(repo(), 'dark-mode')) || t.progress.darkTip;
      if (!mainOid || !dark || (await mergeHead(repo()))) return null;
      if (!(await isAncestor(repo(), dark, mainOid))) return null;
      return `dark-mode merged. Both lines of history are now in ${main}.`;
    },
  },
  {
    id: 'delete-branch',
    title: 'Delete the dark-mode branch',
    text: 'Delete dark-mode. Its commits are already in your main branch.',
    commands: ['git branch'],
    async check(t) {
      if ((await listBranches(repo())).includes('dark-mode')) return null;
      const main = t.progress.mainBranch || 'main';
      return `dark-mode deleted. Its commits are still in ${main}.`;
    },
  },
  {
    id: 'push',
    title: 'Connect to the remote and push',
    text: 'Add the remote with the name origin. Its path is:',
    code: '/remote/origin.git',
    after: 'Then push your main branch to it.',
    commands: ['git remote', 'git push'],
    async check(t) {
      const r = repo();
      const url = await getConfig(r, 'remote.origin.url');
      if (!url) return null;
      const abs = join(url.startsWith('/') ? url : PROJECT + '/' + url);
      if (abs !== REMOTE) return null;
      const main = t.progress.mainBranch || 'main';
      const local = await branchOid(r, main);
      const remote = await remoteMain();
      if (!local || local !== remote) return null;
      return `origin/main points to ${short(remote)}. The remote has ${plural(await remoteCount(), 'commit')}.`;
    },
  },
  {
    id: 'rejected',
    title: 'Push after a teammate pushed',
    text: 'Commit a change. Press Simulate a teammate. Push, read the rejection, then pull and push again.',
    commands: ['git commit', 'git push', 'git pull'],
    teammate: true,
    async check(t) {
      // Any teammate commit counts here, even one made just before this task started.
      const mate = t.progress.teammate;
      if (!mate.length) return null;
      const remote = await remoteMain();
      const main = t.progress.mainBranch || 'main';
      const local = await branchOid(repo(), main);
      if (!remote || remote !== local) return null;
      if (!(await isAncestor(repo(), mate[0].oid, local))) return null;
      return "origin/main now has your commits and the teammate's commit.";
    },
  },
  {
    id: 'conflict',
    title: 'Cause and resolve a conflict',
    text: 'Press Simulate a teammate again. Do not pull yet. In index.html, change the text on this line:',
    code: '<footer>...</footer>',
    after: 'Commit your change. Then pull. In the editor, click an Accept link above the conflict, or edit the markers yourself. Then stage index.html and commit the merge.',
    commands: ['git pull', 'git status', 'git add', 'git commit'],
    teammate: true,
    async check(t) {
      const r = repo();
      if (await mergeHead(r)) return null;
      const mate = t.progress.teammate.filter(x => x.time > t.start.time);
      if (!mate.length || !t.seen('conflict')) return null;
      const head = await headOid(r);
      const html = await fileAt(head, 'index.html');
      if (html === null || /^(<{7}|={7}|>{7})( |$)/m.test(html)) return null;
      for (const c of await revList(r, [head], { exclude: [t.start.head].filter(Boolean) })) {
        if (c.commit.parent.length < 2) continue;
        for (const p of c.commit.parent) {
          if (await isAncestor(r, mate[mate.length - 1].oid, p) || mate.some(m => m.oid === p)) {
            return `Conflict resolved. Merge commit ${short(c.oid)} has 2 parents.`;
          }
        }
      }
      return null;
    },
  },
];

export const FINAL_LINE = 'All tasks complete. Everything you just did works the same way on a real project.';

// ---------- progress ----------

const KEY = 'git-lab:progress';

export function loadProgress() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(KEY)); } catch { /* corrupt */ }
  if (!p || typeof p.current !== 'number') p = { current: 0, done: {}, start: {}, teammate: [] };
  p.teammate = p.teammate || [];
  return p;
}

export function saveProgress(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* full */ }
}

export function clearProgress() {
  localStorage.removeItem(KEY);
}

// Observations: what Git displayed, recorded by the commands themselves.
let clock = 0;
export const tick = () => (clock = Math.max(Date.now(), clock + 1));
const observations = [];
export function observe(kind, data) {
  observations.push({ kind, data: data || {}, time: tick() });
  if (observations.length > 200) observations.shift();
}

export class TaskRunner {
  constructor(onChange) {
    this.progress = loadProgress();
    this.onChange = onChange;
    this.queue = Promise.resolve();
    if (!this.progress.start[TASKS[0].id]) this.begin(0);
  }

  get current() { return this.progress.current; }
  get allDone() { return this.progress.current >= TASKS.length; }

  async begin(i) {
    const task = TASKS[i];
    if (!task) return;
    let head = null;
    try { head = await headOid(repo()); } catch { /* no repo */ }
    if (task.id === 'create-branch' && !this.progress.mainBranch) {
      const b = await currentBranch(repo()).catch(() => null);
      this.progress.mainBranch = b && b !== 'dark-mode' ? b : 'main';
    }
    this.progress.start[task.id] = { time: tick(), head };
    saveProgress(this.progress);
  }

  // Run the current task's check; continue while tasks pass.
  evaluate() {
    this.queue = this.queue.then(() => this.run()).catch(err => console.error(err));
    return this.queue;
  }

  async run() {
    const completed = [];
    while (this.progress.current < TASKS.length) {
      const i = this.progress.current;
      const task = TASKS[i];
      const start = this.progress.start[task.id] || { time: 0, head: null };
      const t = {
        start,
        progress: this.progress,
        seen: (kind, test) => observations.some(o => o.kind === kind && o.time > start.time && (!test || test(o.data))),
        last: (kind, test) => {
          for (let k = observations.length - 1; k >= 0; k--) {
            const o = observations[k];
            if (o.time <= start.time) break;
            if (o.kind === kind && (!test || test(o.data))) return o.data;
          }
          return null;
        },
      };
      let result = null;
      try { result = await task.check(t); } catch (err) { console.warn('check failed', task.id, err); }
      if (!result) break;
      this.progress.done[task.id] = { result, time: Date.now() };
      this.progress.current = i + 1;
      completed.push(task.id);
      await this.begin(i + 1);
      saveProgress(this.progress);
    }
    if (completed.length) this.onChange(completed);
  }

  recordTeammate(oid) {
    this.progress.teammate.push({ oid, time: tick() });
    saveProgress(this.progress);
  }
}

export { pfs };
