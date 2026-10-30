# Herdr Issues

A side panel beside Files and Changes that lists the GitHub issues of the repository the focused terminal is in, with the issue numbers that terminal mentions at the top, and a GitHub-style dialog to read an issue, comment, edit its labels, assign yourself, close and reopen it.

![Herdr Issues](preview.png)

## What you see

- **The Issues button**, at the right end of the tab bar after Files and Changes: a 26px pill with a circle-dot icon and "Issues", `selected` while its panel shows, `chrome` otherwise, like the tab bar's own panel buttons.
- **The panel**, in the side panel column (368px by default) as a card: 10px radius, 1px `border`, `background`.
  - A 42px header: a green (`ansi2`) circle-dot icon, "Issues" semibold, the repository (`owner/name`, 11px, `dim`, truncated, right-aligned) and a bordered "Refresh" button with a round arrow icon, or a spinner and "Syncing".
  - A filter area: a text field ("Filter issues") with a sort button ("Newest ▼"); below it two segmented controls, "Open 177 | Closed 100" on the left and "All | Mine" on the right.
  - The list: rows of `#number` (40px wide, `dim`) and the title (wrapping). When the focused terminal mentions issues, an "In this terminal" heading comes first with those rows (closed ones with a purple `ansi5` number), then a heading for the list below.
  - Before any repository has been seen: a centered circle-dot icon, "No repository yet" and "Focus a terminal inside a GitHub repository and its issues show up here."
- **The issue dialog**, 74% by 88% of the window:
  - A top bar: the repository, a Back button after following a link, an error if the last action failed, a spinner while refreshing or saving, and Refresh, Open on GitHub and ✕ buttons.
  - The title at 24px with a `dim` `#number`, then a state pill (white text on green `ansi2` for Open, purple `ansi5` for Closed or Merged, `dim` for Not planned) and "author opened this issue 3d ago · 5 comments".
  - Left, the thread: per comment a 32px round avatar (initial on a tint picked from the login) beside a card with a 38px bar (author, "commented 3d ago", an "Author" pill for the issue's author) and the markdown body. The first card has an accent border. 2px lines join the avatars. At the bottom a comment box (a textarea growing from 3 to 12 rows) with "Close issue" or "Reopen issue" and a primary "Comment" button.
  - Right, a 250px sidebar: Assignees (with "Assign yourself" or "Unassign me"), Labels (chips tinted with the label's color, with "Edit"), and State ("Close as completed" and "Close as not planned", or "Reopen issue").
- **The sort menu**, a popup: "Sort by" and Newest, Oldest, Recently updated, Least recently updated, Most commented, with a check on the current one.

## How it behaves

- The panel follows the focused terminal's folder (`panes()[i].cwd`), resolved to a repository with `gh repo view`. A folder outside any GitHub repository keeps the last repository; the last one is remembered across restarts.
- A repository's issues show at once from the cache. The first time, and every 6 hours, the panel fetches all open issues (up to 300) and the 100 most recently closed, in full. Every 30 seconds in between it fetches only issues updated since the last sync (`--search updated:>=…`, two minutes of overlap), in either state, and merges them. Refresh syncs now.
- While the panel isn't the shown side panel, it doesn't sync or read terminals; showing it syncs at once.
- Every 3 seconds it reads the focused terminal (`hc read --lines 300`) for `#123` and links to the repository's issues or pull requests, newest line first and each line left to right, up to 8. Numbers that aren't open issues are looked up once (`gh issue view`) and remembered, including ones that don't exist.
- Filtering matches `#number` and title. Mine keeps issues assigned to the `gh` user. The counts on Open and Closed are of the cache.
- Clicking a row opens the dialog with the cached issue, which shows at once and refreshes behind it.
- In the dialog, `#123` and `owner/repo#123` outside code are links: issue and pull request links open in the dialog, with Back; other links open in the browser.
- Comment posts the box (also Ctrl+Enter). Close and Reopen take the box's text along as a comment. Edit lists the repository's labels with a check on the issue's; clicking one adds or removes it at once. Every change runs `gh issue …`, reloads the issue and tells the panel through shared state, which fetches that one issue so the list is current.
- The tab bar remembers each space's side panel only if it's in shared `workspace.panels`; the button adds `issues` there.

## Built from

- **Layout** (`layouts/main-issues.json`): Herdr's `main` 0.1.9. The `tabs` block sits in a 42px row `tab-bar` with a 78px block `issues-button` (`{ mod: "issues", props: { button: true } }`, `window_drag`). The `panel-body` stack gets a third child `issues` (`{ mod: "issues" }`).
- **Mod** `mods/issues/`: `main.js` is the panel, the button (props `button`), the sort menu (overlay props `sortMenu`) and the dialog (overlay props `issue: { repo, number, on, data, me }`), which `viewer.js` draws. `icons.js` writes two Lucide icons (circle-dot, rotate-cw) to `data/issues/icons/`.
- **herdr**: `spaces`, `panes`, `focused`, `layout`, `theme`, `exec`, `hc`, `run` (`layout.select`, `layout.show`, `layout.hide`), `openOverlay`, `closeOverlay`, `props`, `shared` / `setShared` (`issues.sort`, `issues.changed`, `workspace.panels`), `appHome`, `localStorage` (repositories per folder, the `gh` login, the last repository), `fs/promises` (the cache).
- **gpui-base**: `TextView.markdown` with `on_link_click`, `TextareaState` / `Textarea`, `InputState` / `Input`.
- **Programs**: `gh` (`repo view`, `api user`, `issue list`, `issue view`, `issue comment`, `issue close`, `issue reopen`, `issue edit`, `label list`).

## Watch out

- Herdr doesn't draw SVGs from a symlinked mod folder (JavaScript loads fine), so the icons are written to the data folder at start and drawn only after that.
- Herdr doesn't dock a symlinked mod from `mod.json`; `place` is `none` and the layout places it.
- `init`'s first argument isn't the overlay's props: read them with `props()`.
- The cache file holds full issues (bodies and comments) and is around 1 MB for 400 issues. A cache without `version: 2` starts with a full fetch.
- GitHub search can lag a few seconds behind a change, which the two minute overlap covers; the dialog's own changes don't wait for it.
- Pull requests open in the dialog read-only: no comment box, labels or state buttons.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/issues` passes.
- The tab bar shows Files, Changes and Issues; Issues opens and closes the panel, and switching spaces restores it.
- In a terminal inside a GitHub repository, the panel lists its open issues; Closed, Mine, the filter and each sort order change the list.
- `echo "#12"` in that terminal puts #12 under "In this terminal" within 3 seconds.
- A row opens the dialog at once; a `#number` link in the body opens that issue with Back.
- A comment, a label change, close and reopen show on github.com and in the panel's list.
