import { TASKS, FINAL_LINE } from '../tasks.js';
import { PROJECT, isDir } from '../vfs.js';
import {
  findRepo, repoAt, currentBranch, headOid, commitCount, computeStatus, mergeHead, short, plural,
} from '../git/core.js';
import { teammateCommit, remoteMainOid } from '../git/teammate.js';

const NUDGE_AFTER = 90 * 1000;
const CHECK = '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M13.66 4.2 6.5 11.36 2.34 7.2l.7-.7 3.46 3.45 6.46-6.45.7.7Z"/></svg>';
const DOT = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class TaskPanel {
  constructor({ runner, listEl, stripEl, nudgeEl, countEl, teammateBtn, teammateNote, getCwd, afterTeammate }) {
    this.runner = runner;
    this.listEl = listEl;
    this.stripEl = stripEl;
    this.nudgeEl = nudgeEl;
    this.countEl = countEl;
    this.teammateBtn = teammateBtn;
    this.teammateNote = teammateNote;
    this.getCwd = getCwd;
    this.afterTeammate = afterTeammate;
    this.lastStrip = {};
    this.currentSince = Date.now();
    this.lastCurrent = runner.current;
    teammateBtn.addEventListener('click', () => this.simulateTeammate());
    setInterval(() => this.updateNudge(), 5000);
    this.render([]);
  }

  // Called by the runner when tasks complete.
  completed(ids) {
    this.render(ids);
  }

  render(justDone) {
    const p = this.runner.progress;
    const current = this.runner.current;
    if (current !== this.lastCurrent) {
      this.lastCurrent = current;
      this.currentSince = Date.now();
      this.nudgeEl.classList.remove('prominent');
    }
    const items = TASKS.map((t, i) => {
      const state = i < current ? 'done' : i === current ? 'current' : 'locked';
      const mark = state === 'done' ? CHECK : state === 'current' ? DOT : '';
      let body = '';
      if (state === 'current') {
        body = `<div class="body">${esc(t.text)}` +
          (t.code ? `<pre class="task-code">${esc(t.code)}</pre>` : '') +
          (t.after ? esc(t.after) : '') + '</div>';
      }
      else if (state === 'done' && p.done[t.id]) body = `<div class="body">${esc(p.done[t.id].result)}</div>`;
      const cls = `task ${state}${justDone.includes(t.id) ? ' just-done' : ''}`;
      const label = state === 'locked' ? 'locked' : state;
      return `<li class="${cls}" data-id="${t.id}" aria-label="Task ${i + 1}, ${label}"><span class="mark">${mark}</span><span class="num">${i + 1}</span><span class="title">${esc(t.title)}</span>${body}</li>`;
    });
    if (this.runner.allDone) items.push(`<li class="final-line">${esc(FINAL_LINE)}</li>`);
    this.listEl.innerHTML = items.join('');
    this.countEl.textContent = `${Math.min(current, TASKS.length)} of ${TASKS.length}`;
    const cur = this.listEl.querySelector('.task.current') || this.listEl.querySelector('.final-line');
    if (cur) requestAnimationFrame(() => cur.scrollIntoView({ block: 'nearest' }));

    const task = TASKS[current];
    this.nudgeEl.innerHTML = task ? task.commands.map(c => `<span>${esc(c)}</span>`).join('') : '';
    this.updateTeammate();
  }

  updateNudge() {
    if (this.runner.allDone) return;
    if (Date.now() - this.currentSince > NUDGE_AFTER) this.nudgeEl.classList.add('prominent');
  }

  async updateTeammate() {
    const tip = await remoteMainOid();
    this.teammateBtn.disabled = !tip;
    if (!tip && !this.teammateNote.dataset.set) this.teammateNote.textContent = 'The remote has no commits yet.';
    else if (tip && !this.teammateNote.dataset.set) this.teammateNote.textContent = '';
  }

  async simulateTeammate() {
    this.teammateBtn.disabled = true;
    try {
      const r = await teammateCommit(this.runner.progress.teammate.length);
      if (r.ok) {
        this.runner.recordTeammate(r.oid);
        this.teammateNote.dataset.set = '1';
        this.teammateNote.textContent = `Teammate pushed commit ${r.short} to origin/main. It changes ${r.what}.`;
      } else {
        this.teammateNote.textContent = r.reason;
      }
    } finally {
      this.teammateBtn.disabled = false;
      await this.afterTeammate();
    }
  }

  // ---------- ambient state strip ----------

  async updateStrip() {
    this.updateTeammate();
    let repo = await findRepo(this.getCwd());
    if (!repo && (await isDir(PROJECT + '/.git'))) repo = repoAt(PROJECT);
    const parts = [];
    if (!repo) {
      parts.push(['state', null, 'no repository']);
    } else {
      const branch = await currentBranch(repo);
      const head = await headOid(repo);
      const st = await computeStatus(repo);
      const n = await commitCount(repo, head);
      parts.push(['branch', 'branch:', branch || `detached at ${head ? short(head) : '?'}`]);
      parts.push(['commits', null, plural(n, 'commit')]);
      parts.push(['staged', null, `${st.staged.length} staged`]);
      parts.push(['modified', null, `${st.unstaged.length} modified`]);
      if (st.untracked.length) parts.push(['untracked', null, `${st.untracked.length} untracked`]);
      if (st.unmerged.length) parts.push(['conflicts', null, plural(st.unmerged.length, 'conflict')]);
      else if (await mergeHead(repo)) parts.push(['merging', null, 'merging']);
      this.branch = branch;
    }
    const prev = this.lastStrip;
    const html = parts.map(([key, label, value], i) => {
      const bump = prev[key] !== undefined && prev[key] !== value ? ' bump' : '';
      return (i ? '<span class="sep"> · </span>' : '') + `<span class="item">` + (label ? `${esc(label)} ` : '') + `<span class="v${bump}" data-key="${key}">${esc(value)}</span></span>`;
    }).join('');
    this.stripEl.innerHTML = html;
    this.lastStrip = Object.fromEntries(parts.map(([k, , v]) => [k, v]));
    // Let the highlight fade back to the normal colour.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const el of this.stripEl.querySelectorAll('.bump')) el.classList.remove('bump');
    }));
    return { repo, branch: this.branch };
  }
}
