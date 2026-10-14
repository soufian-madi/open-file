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

Summon the overlay through the shell:

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

directly into `fzf --scheme=path --filter=<query>` in the current scope.
There is no blocking cache-building pass or per-path Bash indexing loop;
results use fzf's
path-oriented ranking. Hidden entries are included and VCS ignore rules are
disabled, minus the excluded directories listed above. `Tab` completion runs
its own shallow `fd`/`fzf` pass over the immediate subfolders. User fzf
options are cleared so they cannot change the output protocol. Search output
is byte-limited before entering QML collectors and capped at 200 results.

## Development

The plugin uses the standard third-party overlay lifecycle: Omarchy injects the
scoped `shell` and public `manifest` facades, calls `open(payloadJson)` when the
overlay is summoned, and calls `close()` when it is hidden. The overlay is
loaded on demand and reports its state through `opened`.

Run the parser, search-pipeline, and completion tests with:

```bash
node --test
```

## License

[MIT](LICENSE) — the license keeps the original copyright notice of
[sgruendel/omarchy-fzf](https://github.com/sgruendel/omarchy-fzf).
