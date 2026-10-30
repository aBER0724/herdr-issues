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
- **The issue dialog**, 86% by 90% of the window, drawn after github.com's issue page:
  - A top bar: the repository, a Back button after following a link, an error if the last action failed, a spinner while refreshing or saving, and Refresh, Copy, Open on GitHub and close buttons.
  - The title at 30px, regular weight, wrapping word by word with a `muted` `#number` after its last word. Below it a 32px state pill in GitHub's fixed colors (white on `#238636` Open, `#8957e5` Closed or Merged, `#6e7681` not planned) and an outlined pill per linked pull request.
  - Left, the timeline: full-width cards (6px radius, `border`) with a 38px `raised` header holding a 20px GitHub avatar, the login, "opened on Sep 26" or "29d ago", and pills for bot, Author and the GitHub role (Owner, Member, Contributor). Below the markdown, reaction pills (emoji and count). Events sit between the cards on a 2px line 20px in: a 28px round icon (tag, person, pencil, signpost, link, commit; filled purple for closed, green for reopened, grey for not planned), a 16px avatar, the bold login and what happened ("added Bug label", "closed this as completed", "mentioned this" with the referencing issue or pull request below, "added a commit that references this issue" with its short SHA). Then "Add a comment": a card with Write and Preview tabs, a textarea growing from 4 to 14 rows, "Close issue" (with a ▾ for completed or not planned) or "Reopen issue", and a green "Comment" button.
  - Right, a 264px sidebar of sections split by lines: Assignees ("No one · Assign yourself"), Labels (GitHub-style chips, with Edit), Milestone, Development (the linked pull requests) and Participants (avatars).
- **The copy menu**, a 300 by 222 popup: Copy link, Copy reference (`owner/repo#27`), Copy number (`#27`) and Copy number and title, each with the text it copies below it.
- **The sort menu**, a popup: "Sort by" and Newest, Oldest, Recently updated, Least recently updated, Most commented, with a check on the current one.

## How it behaves

- The panel follows the focused terminal's folder (`panes()[i].cwd`), resolved to a repository with `gh repo view`. Each space remembers the repository its terminals were last in (across restarts): a folder outside any GitHub repository keeps it, and a space that never had one shows the empty state, never another space's repository.
- A repository's issues show at once from the cache. The first time, and every 6 hours, the panel fetches all open issues (up to 300) and the 100 most recently closed, in full. Every 30 seconds in between it fetches only issues updated since the last sync (`--search updated:>=…`, two minutes of overlap), in either state, and merges them. Refresh syncs now.
- While the panel isn't the shown side panel, it doesn't sync or read terminals; showing it syncs at once.
- Every 3 seconds it reads the focused terminal (`hc read --lines 300`) for `#123` and links to the repository's issues or pull requests, newest line first and each line left to right, up to 8. Numbers that aren't open issues are looked up once (`gh issue view`) and remembered, including ones that don't exist.
- Filtering matches `#number` and title. Mine keeps issues assigned to the `gh` user. The counts on Open and Closed are of the cache.
- Clicking a row opens the dialog with the cached issue, which shows at once and refreshes behind it.
- In the dialog, `#123` and `owner/repo#123` outside code are links: issue and pull request links open in the dialog, with Back; other links open in the browser.
- Opening an issue loads it in full (`gh issue view` with milestone, linked pull requests and reactions) and its timeline (`gh api --paginate --slurp repos/…/issues/N/timeline`); label changes by one person within a minute are one line, and project and subscription events are left out. Avatars are downloaded once (`curl` from the timeline's `avatar_url`, else `github.com/<login>.png`) into `data/issues/avatars/`; bots without one get an initial.
- Images in a body or comment (`![alt](url)`, `<img src width>`, outside code) are cut out of the markdown, which draws none, and drawn between its runs: downloaded once into `data/issues/images/`, measured from the file's header (PNG, JPEG, GIF, WebP, SVG), at their width attribute or own width but never wider than the thread column. github.com URLs (private repositories' attachments) go with the `gh` token, piped to `curl -H @-` and dropped by curl on the redirect to GitHub's storage host. Clicking one opens the file.
- Copy (in the issue's top bar, or right-clicking a row in the panel) opens the copy menu; picking a line writes it to the clipboard (`cx.write_to_clipboard`) and shows a "Copied" toast.
- Comment posts the box (also Ctrl+Enter); Preview renders it. Close and Reopen take the box's text along as a comment. Edit lists the repository's labels with a check on the issue's; clicking one adds or removes it at once. Every change runs `gh issue …`, reloads the issue and tells the panel through shared state, which fetches that one issue so the list is current.
- The tab bar remembers each space's side panel only if it's in shared `workspace.panels`; the button adds `issues` there.

## Built from

- **Layout** (`layouts/main-issues.json`): Herdr's `main` 0.1.9. The `tabs` block sits in a 42px row `tab-bar` with a 78px block `issues-button` (`{ mod: "issues", props: { button: true } }`, `window_drag`). The `panel-body` stack gets a third child `issues` (`{ mod: "issues" }`).
- **Mod** `mods/issues/`: `main.js` is the panel, the button (props `button`), the sort menu (overlay props `sortMenu`) and the dialog (overlay props `issue: { repo, number, on, data, me }`), which `viewer.js` draws. `icons.js` writes its Lucide icons to `data/issues/icons/` and downloads avatars to `data/issues/avatars/`; `pictures.js` splits markdown around its images and downloads and measures them. The copy menu is overlay props `copyMenu: { url, ref, number, title }`.
- **herdr**: `spaces`, `panes`, `focused`, `layout`, `theme`, `exec`, `hc`, `run` (`layout.select`, `layout.show`, `layout.hide`), `openOverlay`, `closeOverlay`, `props`, `shared` / `setShared` (`issues.sort`, `issues.changed`, `workspace.panels`), `appHome`, `localStorage` (repositories per folder, the `gh` login, the last repository), `fs/promises` (the cache).
- **gpui-base**: `TextView.markdown` with `on_link_click`, `TextareaState` / `Textarea`, `InputState` / `Input`.
- **Programs**: `gh` (`repo view`, `api user`, `issue list`, `issue view`, `issue comment`, `issue close`, `issue reopen`, `issue edit`, `label list`, `api …/timeline`), `curl` (avatars and images).

## Watch out

- Herdr doesn't draw SVGs or images from a symlinked mod folder (JavaScript loads fine), so icons and avatars live in the data folder and are drawn only once they're on disk; drawing a missing file first would leave it blank.
- The markdown view (`TextView.markdown`) draws no images at all, not even the alt text.
- There's no inline styled text: the title is one element per word in a wrapping row, so the muted number can follow its last word.
- Saving a mod file reloads it; a dialog that was loading at that moment shows "interrupted". Reopen it.
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
