# gitGud

A Git practice environment that runs entirely in the browser. It has an editor, a terminal, a file tree, a live preview and a list of 22 tasks. There is no server. After the first visit it works offline.

All Git operations run through [isomorphic-git](https://isomorphic-git.org). Files and repositories live in IndexedDB through [LightningFS](https://github.com/isomorphic-git/lightning-fs), so work survives a page refresh.

## Run it

```
npm install
npm run dev        # development server
npm run build      # static files in dist/
npm test           # runs the full task sequence in Node
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository, on the `main` branch.
2. In the repository settings, open **Pages** and set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/deploy.yml` builds and publishes `dist/`.

The build uses relative paths, so it works at a subpath such as `https://<user>.github.io/<repo>/`. Any static host works the same way.

## How it works

| Part | Where |
| --- | --- |
| Virtual filesystem and starting files | `src/vfs.js` |
| Terminal line editor (history, Tab, Ctrl+C) | `src/shell/terminal.js` |
| Shell parser and commands (`ls`, `cd`, `echo >`, ...) | `src/shell/shell.js` |
| Git commands and their output | `src/git/*.js` |
| Remote simulation (clone, fetch, push, pull) | `src/git/remote.js` |
| "Simulate a teammate" | `src/git/teammate.js` |
| Tasks and their checks | `src/tasks.js` |
| Editor, file tree, preview, task panel | `src/ui/` |

### Remotes without a network

`/remote/origin.git` is a bare repository inside the virtual filesystem. Push, fetch, pull and clone copy Git objects between the two repositories with isomorphic-git's `readObject` and `writeObject`, then update refs with `writeRef`. The objects keep their real hashes. Merges use isomorphic-git's `merge`, which writes real conflict markers. In the editor, each conflict shows VS Code's "Accept Current Change | Accept Incoming Change | Accept Both Changes" links. Learners can use them or edit the markers by hand.

### Task checks

Each check reads real state: the repository, the staging area, the files and the remote. Some tasks are about reading output ("Run git status", "View your history"). For those, the Git commands record what they displayed, for example "a one-line log of 3 commits" or "a diff of 1 unstaged file". Checks never look at the typed command line, so any valid route counts: `git log --oneline` and `git log --pretty=oneline` both complete task 8.

### Lab machine defaults

The starting global config (`~/.gitconfig`) contains:

```
[init]
	defaultBranch = main
[pull]
	rebase = false
```

`init.defaultBranch` gives the branch name the tasks expect. `pull.rebase = false` stops recent Git versions from refusing `git pull` on divergent branches, so task 21 teaches the merge. Learners can see these with `git config --list`.

### Differences from real Git

- There is no text editor in the terminal. `git commit` without `-m` works only to finish a merge, using the prepared merge message.
- `git diff` during a conflict prints `* Unmerged path <file>` instead of a combined diff.
- Push and fetch progress lines show real object counts, without delta compression.
- Commands outside the lab's list (for example `stash`, `rebase`, `reset`) print a short note that they are not available.

## Resetting

The **Reset** button in the title bar deletes the IndexedDB filesystem, the task progress and the command history, then restores the 4 starting files.

## Regenerating the Monaco entry

`src/ui/monaco-entry.js` is generated from Monaco's own `editor.main.js` with only the languages this lab needs. After upgrading `monaco-editor`, run `npm run gen:monaco`.
