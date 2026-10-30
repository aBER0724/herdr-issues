# Herdr Issues

A GitHub issues panel for the [Herdr](https://herdr.dev) desktop app. It sits next to Files and Changes in the tab bar, follows the repository of the terminal you're in, and opens issues in a GitHub-style view where you can comment, edit labels, assign yourself, close and reopen.

![Issues panel](preview.png)

- **Follows your focus.** The panel shows the issues of the GitHub repository of the focused terminal. Each space remembers its own repository, so a terminal outside any repository keeps showing that one.
- **In this terminal.** Issue numbers (`#123`) and issue or pull request links on the focused terminal's screen are listed at the top, newest first, so an agent's "fixed #55" is one click away.
- **Open and closed, sorted your way.** Filter on open or closed, all or assigned to you, or by text, and sort the way GitHub does: newest, oldest, recently updated, least recently updated, most commented.
- **Fast.** Issues are cached per repository. After the first fetch, only what changed since the last sync is fetched, every 30 seconds while the panel is open.
- **A GitHub-style issue view.** The timeline as github.com draws it: comments with avatars, roles and reactions, and the events between them (labels, assignments, references, commits, closing). Markdown with tables and code, `#123` links that open in place with Back, a comment box with preview, and a sidebar for assignees, labels, milestone, linked pull requests and participants.

![Issue view](issue.png)

## Install

You need the [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`.

Clone this repository and link the mod into Herdr's home, so a `git pull` updates it:

```sh
git clone https://github.com/jankeesvw/herdr-issues.git ~/Documents/github.com/jankeesvw/herdr-issues
ln -s ~/Documents/github.com/jankeesvw/herdr-issues/mods/issues ~/.config/herdr-app/mods/issues
cp ~/Documents/github.com/jankeesvw/herdr-issues/layouts/main-issues.json ~/.config/herdr-app/layouts/
herdr-app do layout.switch --name main-issues
```

`main-issues` is Herdr's own `main` layout (0.1.9) with the Issues panel and its button added. `ctrl-shift-l` switches back to any other layout.

### Your own layout

Already have a layout of your own? Add two blocks to it. The panel goes in the side panel stack with Files and Changes:

```json
{ "id": "panel-body", "type": "stack", "children": [
  { "id": "files", "type": "block", "content": { "mod": "files" } },
  { "id": "changes", "type": "block", "content": { "mod": "changes" } },
  { "id": "issues", "type": "block", "content": { "mod": "issues" } } ] }
```

And the Issues button next to the tab bar, which opens and closes that panel:

```json
{ "id": "tab-bar", "type": "row", "size": { "px": 42 }, "resizable": false, "children": [
  { "id": "tabs", "type": "block", "window_drag": true, "content": { "mod": "tabs" } },
  { "id": "issues-button", "type": "block", "size": { "px": 78 }, "window_drag": true, "content": { "mod": "issues", "props": { "button": true } } } ] }
```

The mod also works as a pane of its own: `herdr-app do pane.split --direction right --mod issues`.

## What it runs and stores

The mod runs `gh` (on the machine of the space, for remote spaces) and `hc read` on the focused terminal to find issue numbers. It changes issues only when you press a button in the issue view. Its cache lives in `~/.config/herdr-app/data/issues/`, next to the icons and GitHub avatars it saves there (Herdr doesn't load images from a symlinked mod folder).
