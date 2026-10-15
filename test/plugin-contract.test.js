const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const root = path.join(__dirname, "..")

test("declares valid on-demand Omarchy overlay and bar widget entry points", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))

  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.id, "soufian.open-file")
  assert.deepEqual(manifest.kinds, ["overlay", "bar-widget"])
  assert.equal(manifest.entryPoints.overlay, "Fzf.qml")
  assert.equal(manifest.entryPoints.barWidget, "FolderButton.qml")
  assert.equal(manifest.keepLoaded, undefined)
  assert.ok(fs.existsSync(path.join(root, manifest.entryPoints.overlay)))
  assert.ok(fs.existsSync(path.join(root, manifest.entryPoints.barWidget)))
})

test("places a single bar widget on the right by default", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))

  assert.equal(typeof manifest.barWidget, "object")
  assert.equal(manifest.barWidget.allowMultiple, false)
  assert.equal(manifest.barWidget.defaultSection, "right")
})

test("implements the Omarchy overlay lifecycle and scoped host injection", () => {
  const qml = fs.readFileSync(path.join(root, "Fzf.qml"), "utf8")

  assert.match(qml, /^\s*property var shell: null$/m)
  assert.match(qml, /^\s*property var manifest: null$/m)
  assert.match(qml, /^\s*property bool opened: false$/m)
  assert.match(qml, /^\s*function open\(payloadJson\) \{$/m)
  assert.match(qml, /^\s*function close\(\) \{$/m)
  assert.match(qml, /root\.shell\.hide\(\(root\.manifest && root\.manifest\.id\) \|\| "soufian\.open-file"\)/)
  assert.doesNotMatch(qml, /\bFileView\s*\{/)
  assert.match(qml, /maxSearchOutputBytes:\s*262144/)
})

test("bar widget toggles the overlay through the scoped host injection", () => {
  const qml = fs.readFileSync(path.join(root, "FolderButton.qml"), "utf8")

  assert.match(qml, /^BarWidget \{$/m)
  assert.match(qml, /^\s*moduleName: "soufian\.open-file"$/m)
  assert.match(qml, /typeof bar\.shell\.toggle === "function"/)
  assert.match(qml, /bar\.shell\.toggle\(id, "\{\}"\)/)
  assert.match(qml, /bar\.run\("omarchy-shell shell toggle " \+ id\)/)
  assert.match(qml, /text: "\\uf07b"/)
})
