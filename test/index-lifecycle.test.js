const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const SearchCommand = require("../SearchCommand.js")

const qml = fs.readFileSync(path.join(__dirname, "..", "Fzf.qml"), "utf8")

function lifecycle(overrides = {}) {
  const context = {
    root: {
      stateDirReady: true, indexReady: false, indexedScope: "",
      dirs: [{ path: "/home/test" }], indexPath: "/state/index", maxIndexBytes: 4096,
      opened: true, activeIndex: 0, searching: true, searchGen: 20,
      runSearch() { this.retries = (this.retries || 0) + 1 },
      ...overrides
    },
    indexProc: { running: false, pendingScope: "", errorText: "", exec() { this.running = true } },
    stateDirProc: { running: false },
    fieldsRepeater: { itemAt() { return { text: "scope/latest" } } },
    SearchCommand
  }
  vm.createContext(context)
  // Execute the actual QML method/handler bodies, rather than a copy of them.
  const ensureIndex = qml.match(/  function ensureIndex\(prefix\) \{([\s\S]*?)\n  \}\n/)[1]
  const indexBlock = qml.split("    id: indexProc\n")[1].split("\n  Process {")[0]
  const exited = indexBlock.match(/    onExited: function\(exitCode\) \{([\s\S]*?)\n    \}\n/)[1]
  vm.runInContext(`function ensureIndex(prefix) {${ensureIndex}\n}
    function indexExited(exitCode) {${exited}\n}`, context)
  return context
}

test("keeps a running index's scope metadata immutable until exit", () => {
  const c = lifecycle()
  c.indexProc.running = true
  c.indexProc.pendingScope = "old/"
  assert.equal(c.ensureIndex("new/"), false)
  assert.equal(c.indexProc.pendingScope, "old/")
  c.indexExited(0)
  assert.equal(c.root.indexedScope, "old/")
  assert.equal(c.root.retries, 1)
})

test("invalidates the previous cache before indexing a different scope", () => {
  const c = lifecycle({ indexReady: true, indexedScope: "old/" })
  assert.equal(c.ensureIndex("new/"), false)
  assert.equal(c.root.indexReady, false)
  assert.equal(c.indexProc.pendingScope, "new/")
})

test("reports an index failure even after more letters advance the generation", () => {
  const c = lifecycle()
  c.indexProc.pendingScope = "scope/"
  c.indexProc.errorText = "index failed"
  c.indexExited(1)
  assert.equal(c.root.searching, false)
  assert.equal(c.root.searchError, "index failed")
})

test("retries the current scope when an obsolete scope fails", () => {
  const c = lifecycle()
  c.indexProc.pendingScope = "old/"
  c.indexExited(1)
  assert.equal(c.root.retries, 1)
  assert.equal(c.root.searching, true)
})

test("retries state directory preparation instead of waiting indefinitely", () => {
  const c = lifecycle({ stateDirReady: false })
  assert.equal(c.ensureIndex("scope/"), false)
  assert.equal(c.stateDirProc.running, true)
})
