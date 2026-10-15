# open-file

A Quickshell overlay for [Omarchy](https://omarchy.org/) that fuzzy-finds
files and folders anywhere in your home directory and opens them.

> **Based on** [sgruendel/omarchy-fzf](https://github.com/sgruendel/omarchy-fzf)
> by Stefan Gründel. That plugin searches the XDG user directories; this fork
> searches the whole home directory, completes folder paths with `Tab`, and
> opens files through their MIME association (Neovim handlers run in a foot
> terminal).

## What it does

The overlay shows a single **Home** field. As soon as you type, matching files
and folders from your home directory appear below, ranked by fzf. Hidden
entries are included, but noisy directories are excluded (`.git`, `.cache`,
`node_modules`, `.npm`, `.steam`, `.gradle`, `.cua-driver`, Steam data, and the
Trash). Selecting an entry opens it with its default application.

`Tab` completes the best fuzzy-matching immediate child folder — `adult` finds
`Adulting/` — and keeps completing subfolders as you go. A completed folder
prefix narrows the search to that folder while results keep showing
home-relative paths. Reopening the overlay lands you back in the folder scope
you last searched.

## Requirements

- Omarchy 4.0.4+ with the Quickshell plugin API
- [`fzf`](https://github.com/junegunn/fzf)
- [`fd`](https://github.com/sharkdp/fd)
- `xdg-open` and `xdg-mime` (`xdg-utils`)

## Install

```bash
omarchy plugin add https://github.com/soufian-madi/open-file.git --enable
```

## Remove

```bash
omarchy plugin remove soufian.open-file --yes
rm -f -- "${XDG_STATE_HOME:-$HOME/.local/state}/soufian.open-file/state.json"
rmdir -- "${XDG_STATE_HOME:-$HOME/.local/state}/soufian.open-file" 2>/dev/null || true
```

## Usage

The plugin registers a **folder icon** in the bar — the right section by
default, since `barWidget.defaultSection` is `right`. Click it to summon the
overlay and again to close it. Move it with:

```bash
omarchy bar move soufian.open-file --section left
```

The overlay can also be summoned through the shell:

```bash
omarchy-shell shell toggle soufian.open-file
```

To bind it to a key, add a line like this to `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + ALT + X", "File search", "omarchy-shell shell toggle soufian.open-file")
```

## Controls

- Type: fuzzy-search files and folders across your home directory
- `Tab`: complete the current folder path
- `Up` / `Down` or `Ctrl+K` / `Ctrl+J`: move the result selection
- `PageUp` / `PageDown` or `Ctrl+U` / `Ctrl+D`: move by ten results
- `Enter`: open the selected entry with its default application
- `Escape`: clear the current search, or close the overlay when empty
- Click a result to open it; click outside the card to close the overlay

## Opening files

Files open through their MIME association (`xdg-mime query filetype` /
`query default`). Handlers mapped to `nvim.desktop` or `neovim.desktop` launch
`foot nvim -- <path>`, since `xdg-open` does not reliably start `Terminal=true`
handlers in this session. Everything else opens with `xdg-open`.

## State

The folder scope you last searched in — the query text up to and including its
last slash, e.g. `Ai-folders/voice-message-to-seer/` — is stored in
`${XDG_STATE_HOME:-$HOME/.local/state}/soufian.open-file/state.json`.
Reopening the overlay restores it, so you land back in that folder. The state
file is limited to 8 KiB and written atomically with mode `0600` inside a mode
`0700` plugin directory. No search query or result history is persisted.

Older versions also wrote an `index` cache here. It is no longer used and can
be deleted at any time.

## How it works

After a 150 ms typing debounce, the overlay runs

```bash
fd --type f --type d --hidden --no-ignore-vcs --exclude .git --exclude .cache …
```

directly into `fzf --scheme=path` in the current scope.
There is no blocking cache-building pass or per-path Bash indexing loop;
results use fzf's
path-oriented ranking. Hidden entries are included and VCS ignore rules are
disabled, minus the excluded directories listed above. `Tab` completion runs
its own shallow `fd`/`fzf` pass over the immediate subfolders. User fzf
options are cleared so they cannot change the output protocol. Search output
is byte-limited before entering QML collectors and capped at 200 results.

Typed queries and folder scopes never appear on a command line. `/proc/<pid>/cmdline`
is world-readable on Linux, which would expose searches to other local users
while they run, so the query and scope reach the search script over standard
input, and fzf receives the query as a quoted `--filter` option read from an
inherited file descriptor (fzf ≥ 0.47). On older fzf that option comes through
`FZF_DEFAULT_OPTS` instead, which `/proc/<pid>/environ` exposes only to your
own user. The saved folder scope is written to the state file over standard
input as well. Nothing you type is ever passed as a command line argument.

## Development

The plugin uses the standard third-party overlay lifecycle: Omarchy injects the
scoped `shell` and public `manifest` facades, calls `open(payloadJson)` when the
overlay is summoned, and calls `close()` when it is hidden. The overlay is
loaded on demand and reports its state through `opened`.

The folder button is a second entry point (`FolderButton.qml`, kind
`bar-widget`). The bar host injects its scoped `bar` facade plus `moduleName`
and `settings`; the button summons the same overlay through the scoped `shell`
facade, falling back to `omarchy-shell shell toggle` when that facade is
unavailable. The entry point is deliberately **not** named `BarWidget.qml`:
a plugin-side QML file whose name matches the type it inherits (the `BarWidget`
base from `qs.Ui`) fails to load with `File name case mismatch`. `FolderButton.qml`
inherits `BarWidget` without shadowing the type name. Gotcha: after such a
failure the running shell keeps returning that error for every widget load from
the plugin directory until `omarchy restart shell` — renaming alone does not
clear it.

Run the parser, search-pipeline, and completion tests with:

```bash
node --test
```

## License

[MIT](LICENSE) — the license keeps the original copyright notice of
[sgruendel/omarchy-fzf](https://github.com/sgruendel/omarchy-fzf).
