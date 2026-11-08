# AGENTS.md

## "Release new version" — the ritual

When the user says **"release new version"**, **"release this"**, **"cut a release"**, or
**"release as vX.Y"**, it means the ritual below. Do it end-to-end without re-asking,
then report the release URL.

1. **Bump the version** in `manifest.json` (`"version": "X.Y"`) and commit/push:
   ```bash
   git add -A && git commit -m "chore: bump manifest version to X.Y"
   git push origin main
   ```
2. **Run the tests** — all must pass first:
   ```bash
   node --test test/*.test.js
   ```
3. **Tag + publish** in one step (`gh` creates the tag at HEAD if it doesn't exist):
   ```bash
   gh release create vX.Y --title "vX.Y" --latest \
     --notes "<short changelog since the previous release>"
   ```
4. Report the release URL.

## Conventions

- Release tags/titles are `vX.Y`; the manifest version is the same number without the
  `v` (`v1.1` ↔ `"version": "1.1"`). Keep them in sync.
- Versions are two-part `X.Y`. With no version named in the request, increment `Y`
  (1.1 → 1.2). An explicit "release as v1.4" wins.
- Notes are plain bullets summarizing what changed since the previous release, ending
  with the install line:
  `omarchy plugin add https://github.com/soufian-madi/open-file.git --enable`
- `gh release create ... --generate-notes` is fine as a first draft; tidy it with
  `gh release edit vX.Y --notes ...`.

## Gotchas

- Releases are for humans: `omarchy-plugin-update` fast-forwards the **branch**
  (`git fetch origin HEAD` + `--ff-only` merge) and ignores tags entirely.
- Never move/force-push an already published tag unless the user explicitly says so.
  Fix a published release with `gh release edit`, or ship a follow-up version instead.
- Tests must run as `node --test test/*.test.js` — `node --test test/` (bare directory)
  fails spuriously.
- Legacy local-only tags `1.0.0`, `1.1.0`–`1.1.3` sit on old pre-rebrand commits and were
  never pushed to GitHub. Ignore them and don't reuse those names.

## Working techniques

### Verify Qt behavior, don't recall it

Qt/QML behavior is easy to misremember. Before you design around something,
measure it headlessly with `qml6`:

```bash
QT_QPA_PLATFORM=offscreen QT_FORCE_STDERR_LOGGING=1 timeout 10 qml6 probe.qml -- args
```

- Without `QT_FORCE_STDERR_LOGGING=1`, `console.log` prints **nothing**.
- The root object must be a `Window { visible: true }`. A bare `Item` loads
  nothing and exits silently.
- Read script arguments with
  `Qt.application.arguments[Qt.application.arguments.length - 1]`.
- Quit from a `Timer` with `Qt.callLater(Qt.quit)`.
- Keep probe files in a scratch directory (e.g. `/tmp/...`), never in the repo.

### Headless harness for the plugin's own QML

You can load the real plugin files outside the shell. Point `QML_IMPORT_PATH`
at a scratch directory that holds stubs:

- `qs/Commons/qmldir` declaring `singleton Style` and `singleton Color`.
  Implement only the tokens the file reads: `Style.space()`, `Style.duration()`,
  `spacing.*`, `font.*`, `normalFillAlpha`, `cornerRadius`, `Color.menu.text`.
- `Quickshell/Widgets/ClippingRectangle.qml` as a plain `Rectangle { clip: true }`.
  Quickshell's C++ plugins exist only inside the quickshell binary.

Then import the plugin directory by URL in the harness:
`import "file:///home/<user>/.config/omarchy/plugins/soufian.open-file" as P`.

The harness covers:

- **Screenshots:** `contentItem.grabToImage(r => r.saveToFile(...))`. The grab
  skips the window color, so add a background `Rectangle` yourself. This is the
  safe way to compare dark and light palettes without switching the user's theme.
- **GUI-thread stalls:** a 1 ms repeating `Timer` that records the largest gap
  between ticks. The baseline is about 2 ms when idle and about 17 ms while an
  animation renders. Anything clearly above that is real main-thread work.
  Bisect the cause by editing a *copy* of the component.

### QML pitfalls found here

- **Binding glitches:** a binding derived from two other derived properties can
  briefly see one updated and the other stale. For example, `w * h` saw
  `1920 * 0` and passed a size budget. Compute such values in **one** binding
  from source values that are all set before the flag that triggers it flips.
- **Image decoding** (the details are in `PreviewPane.qml`'s header comment):
  - `PreserveAspectFit` plus `sourceSize` makes Qt scale the *decode* to cover
    the box: small images upscale, panoramas over-decode.
  - The default `Stretch` fill only ever shrinks.
  - SVG renders at exactly `sourceSize`.
  - `AnimatedImage` stretches to `sourceSize` and decodes every frame on the
    GUI thread.
  - With `autoTransform`, the bound applies before EXIF rotation.
  - `implicitWidth` is in physical pixels.
  - `Image.frameCount` arrives *after* `status === Ready`.
- `FolderListModel` (`Qt.labs.folderlistmodel`) lists directories in-process
  and asynchronously. A missing folder reports `Ready` with 0 entries. This is
  the way to check whether files exist without a subprocess or failed-load
  warnings.
- The repo's tests parse QML with regexes. Keep that format:
  - Each `Text {` stands on its own line, has its closing brace at the same
    indent, and includes `textFormat: Text.PlainText`.
  - Functions under test use the form `  function name() {` … `\n  }\n`.
- After writing a new static test, mutation-check it: break the code with `sed`,
  confirm the test fails, then restore.

### Live testing on the user's desktop

- Plugin QML changes need `omarchy restart shell`. Open the overlay with
  `omarchy-shell shell toggle soufian.open-file`.
- Before injecting keys, confirm the overlay has the keyboard:
  `hyprctl layers -j | grep -q soufian-open-file`. Stray keystrokes land in the
  user's focused window, so this check is mandatory.
- `wtype`:
  - Each call uploads a new keymap, and Qt recompiles it. Many small calls look
    like UI lag that isn't there. Send a whole sequence in **one** call:
    `wtype -k Down -s 8 -k Down ...`.
  - Prefer lowercase text. Reach capitalized folders through Tab completion.
- Overlay key traps:
  - On open, the remembered scope is restored into the field. Clear it with
    BackSpace, not Escape: Escape on an empty field closes the overlay.
  - `Ctrl+U`/`Ctrl+D` page the list; they don't edit text.
- Screenshots:
  - `grim -o <output> file.png` captures physical pixels. Crop to the card with
    `magick ... -crop`.
  - The read tool sometimes lags behind newly written files. Retry, or use a
    fresh filename.
- Hyprland 0.56 uses Lua dispatch:
  - Move the pointer: `hyprctl dispatch 'hl.dsp.cursor.move({ x = 60, y = 1350 })'`.
  - Switch to an empty workspace for a clean background:
    `hyprctl dispatch 'hl.dsp.focus({ workspace = 9 })'`.
  - Afterwards, put the workspace and pointer back.
  - A pointer warp does not emit hover events.
- Shell logs: run `qs list --all`, take the instance whose config is
  `/usr/share/omarchy/shell/shell.qml`, then `qs log --id <id>`. The warning
  "Module path … is outside of the config folder" is normal for every user plugin.
- Performance claims need a baseline. Run the same scripted test on `main`
  (`git stash -u`, restart the shell, test, `git stash pop`, restart again) and
  compare.

### Clean up what testing changes

- Test searches overwrite the remembered scope in
  `${XDG_STATE_HOME:-~/.local/state}/soufian.open-file/state.json`. Back it up
  first. Restore it with `cat backup > state.json`, which keeps mode 0600. Then
  restart the shell: the running overlay holds the scope in memory and would
  write it back.
- Search covers only `$HOME`, and `.cache` is excluded, so fixtures must live in
  a throwaway `~/<dir>`. Delete them afterwards, along with anything you placed
  in caches such as `~/.cache/thumbnails`.

### Public repo hygiene

- The repo is public. Tests and fixtures use synthetic paths (`/home/test/...`),
  never real filenames from the user's machine.
- Before pushing, grep the diff for personal data: name, email, home paths,
  monitor names, hosts, tokens.
- README screenshots:
  - Shoot on an empty workspace, with demo files copied from
    `/usr/share/omarchy/themes/*/backgrounds/` (public artwork).
  - Strip metadata:
    `magick in.png -strip -define png:exclude-chunk=date,time,tIME out.png`.
  - Don't reduce to 256 colors: the dither shows in the flat UI surfaces.
