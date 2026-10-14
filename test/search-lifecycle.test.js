const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const qml = fs.readFileSync(path.join(__dirname, "..", "Fzf.qml"), "utf8")

test("starts a direct search without waiting for state storage or an index", () => {
  const calls = []
  const context = {
    root: {
      activeIndex: 0, dirs: [{ path: "/home/test" }], searchGen: 12,
      stateDirReady: false, maxResults: 200, maxSearchOutputBytes: 262144
    },
    fieldsRepeater: { itemAt() { return { text: "folder/a" } } },
    SearchCommand: {
      searchCommand(...args) { calls.push(args); return ["search"] }
    },
    searchProc: { exec(command) { this.command = command } }
  }
  vm.createContext(context)
  const body = qml.match(/  function runSearch\(\) \{([\s\S]*?)\n  \}\n/)[1]
  vm.runInContext(`function runSearch() {${body}\n}; runSearch()`, context)

  assert.deepEqual(calls, [["folder/a", "/home/test", 200, 262144]])
  assert.deepEqual(context.searchProc.command, ["search"])
  assert.equal(context.searchProc.pendingGen, 12)
  assert.doesNotMatch(qml, /indexProc|ensureIndex|indexReady/)
})
