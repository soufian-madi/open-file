const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const root = path.join(__dirname, "..")
const pane = fs.readFileSync(path.join(root, "PreviewPane.qml"), "utf8")
const fzf = fs.readFileSync(path.join(root, "Fzf.qml"), "utf8")

// Every Image or AnimatedImage block, including `sourceComponent: AnimatedImage {`.
function imageBlocks(source) {
  const lines = source.split("\n")
  const blocks = []
  for (let start = 0; start < lines.length; start++) {
    const match = lines[start].match(/^(\s*)(?:[\w.]+:\s*)?(Image|AnimatedImage) \{$/)
    if (!match) continue
    const end = lines.findIndex((line, index) => index > start && line === `${match[1]}}`)
    assert.notEqual(end, -1, `unclosed ${match[2]} at line ${start + 1}`)
    const block = lines.slice(start, end + 1).join("\n")
    blocks.push({ type: match[2], id: (block.match(/^\s*id: (\w+)$/m) || [])[1], block })
  }
  return blocks
}

test("decodes every preview image off the GUI thread and without caching", () => {
  const blocks = imageBlocks(pane)
  assert.ok(blocks.length >= 4, "expected probe, sizeProbe, still and animated images")
  for (const { type, id, block } of blocks) {
    assert.match(block, /^\s*asynchronous: true$/m, `${type} ${id}`)
    assert.match(block, /^\s*cache: false$/m, `${type} ${id}`)
  }
})

test("bounds the still image decode with sourceSize and a shrink-only fill", () => {
  const still = imageBlocks(pane).find(b => b.id === "still")
  assert.ok(still, "still image")
  assert.match(still.block, /^\s*sourceSize\.width: .*pane\.bound$/m)
  assert.match(still.block, /^\s*sourceSize\.height: .*pane\.bound$/m)
  // PreserveAspectFit makes Qt scale the decode up to cover sourceSize, so
  // raster images must use Stretch; only SVG renders with a preserving fill.
  assert.match(still.block, /^\s*fillMode: pane\.vector \? Image\.PreserveAspectFit : Image\.Stretch$/m)
  assert.match(still.block, /^\s*autoTransform: true$/m)
  assert.match(pane, /readonly property int bound: Math\.ceil\(Math\.max\(stage\.width, stage\.height\) \* dpr\)/)
})

test("hands animations the still's exact size and gates them on a pixel budget", () => {
  const anim = imageBlocks(pane).find(b => b.type === "AnimatedImage")
  assert.ok(anim, "animated image")
  assert.match(anim.block, /^\s*sourceSize\.width: still\.implicitWidth$/m)
  assert.match(anim.block, /^\s*sourceSize\.height: still\.implicitHeight$/m)
  assert.match(pane, /active: pane\.mayAnimate$/m)
  assert.match(pane, /property int maxAnimatedPixels: 500000$/m)
  // The budget must come from one binding: a width/height product glitches.
  assert.match(pane, /readonly property bool mayAnimate: multiFrame && originalPixels > 0\n\s*&& originalPixels <= maxAnimatedPixels/)
  assert.match(pane, /readonly property bool multiFrame: kind === "animated" && stillOk && still\.frameCount > 1/)
})

test("keeps the preview purely visual: no input, focus or subprocesses", () => {
  for (const pattern of [/\bMouseArea\b/, /\bTextInput\b/, /\bTextEdit\b/, /\bKeys\./, /forceActiveFocus/,
    /^\s*focus: true/m, /activeFocusOnTab: true/, /\bProcess\b/, /execDetached/, /\bFileView\b/]) {
    assert.doesNotMatch(pane, pattern, String(pattern))
  }
})

test("shows the pane only when the screen fits it, bound to the debounced path", () => {
  assert.match(fzf, /^\s*readonly property int previewDelay: 80$/m)
  assert.match(fzf, /^\s*interval: root\.previewDelay$/m)
  assert.match(fzf, /^\s*path: root\.previewPath$/m)
  assert.match(fzf, /^\s*visible: root\.showPreview && root\.activeIndex !== -1$/m)
  assert.match(fzf, /readonly property bool showPreview: panel\.width - Style\.gapsOut \* 2 >= listCardWidth \+ previewMinWidth/)
  // Narrow screens keep the original single-column card width.
  assert.match(fzf, /readonly property int listCardWidth: Style\.space\(560\)/)
  assert.match(fzf, /property int cardWidth: Math\.min\(showPreview \? previewCardWidth : listCardWidth, panel\.width - Style\.gapsOut \* 2\)/)
})

function previewHarness(state) {
  const body = name => fzf.match(new RegExp(`  function ${name}\\(\\) \\{([\\s\\S]*?)\\n  \\}\\n`))[1]
  const events = []
  const context = {
    root: Object.assign({
      opened: true, showPreview: true, activeIndex: 0, selectedIndex: 0,
      dirs: [{ path: "/home/test" }], previewPath: "stale"
    }, state.root),
    resultModel: {
      count: state.paths.length,
      get(i) { return { path: state.paths[i] } }
    },
    previewDebounce: {
      stop() { events.push("stop") },
      restart() { events.push("restart") }
    }
  }
  vm.createContext(context)
  vm.runInContext(`function schedulePreview() {${body("schedulePreview")}\n}
function updatePreview() {${body("updatePreview")}\n}`, context)
  return { context, events }
}

test("debounces the preview while there is a selection", () => {
  const { context, events } = previewHarness({ paths: ["Pictures/a b.png"], root: {} })
  vm.runInContext("schedulePreview()", context)
  assert.deepEqual(events, ["restart"])
  assert.equal(context.root.previewPath, "stale")
  vm.runInContext("updatePreview()", context)
  assert.equal(context.root.previewPath, "/home/test/Pictures/a b.png")
})

test("clears the preview at once when there is nothing to show", () => {
  const cases = [
    { paths: [], root: {} },
    { paths: ["a.png"], root: { opened: false } },
    { paths: ["a.png"], root: { showPreview: false } },
    { paths: ["a.png"], root: { activeIndex: -1 } }
  ]
  for (const state of cases) {
    const { context, events } = previewHarness(state)
    vm.runInContext("schedulePreview()", context)
    assert.deepEqual(events, ["stop"], JSON.stringify(state))
    assert.equal(context.root.previewPath, "", JSON.stringify(state))
  }
  const { context } = previewHarness({ paths: ["a.png"], root: { selectedIndex: 3 } })
  vm.runInContext("updatePreview()", context)
  assert.equal(context.root.previewPath, "")
})

test("follows selection, results, scope and visibility changes", () => {
  assert.match(fzf, /^\s*onSelectedIndexChanged: root\.schedulePreview\(\)$/m)
  assert.match(fzf, /^\s*onActiveIndexChanged: root\.schedulePreview\(\)$/m)
  assert.match(fzf, /^\s*onOpenedChanged: root\.schedulePreview\(\)$/m)
  assert.match(fzf, /^\s*onShowPreviewChanged: root\.schedulePreview\(\)$/m)
  assert.match(fzf, /ListModel \{\n\s*id: resultModel\n\s*onCountChanged: root\.schedulePreview\(\)/)
})

test("looks thumbnails up in-process and never generates them", () => {
  assert.match(pane, /^import Qt\.labs\.folderlistmodel$/m)
  assert.match(pane, /active: pane\.thumbnailsWanted$/m)
  assert.match(pane, /onThumbnailKindChanged: if \(thumbnailKind\) thumbnailsWanted = true/)
  assert.match(pane, /PreviewKind\.thumbnailNames\(path, Qt\.md5\)/)
  assert.equal((pane.match(/FolderListModel \{/g) || []).length, 3)
  // Thumbnail sizes are the document's, not the thumbnail's: no dimensions.
  assert.match(pane, /readonly property bool exactSize: stillOk && decodable && !vector/)
  assert.match(fzf, /^\s*thumbnailRoot: root\.cacheHome \+ "\/thumbnails"$/m)
  // No generator is ever invoked (the pane also has no Process at all).
  assert.doesNotMatch(pane + fzf, /[\w-]+-thumbnailer|ffmpegthumbnailer|pdftoppm|org\.freedesktop\.thumbnails/)
})
