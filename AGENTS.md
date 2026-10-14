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
