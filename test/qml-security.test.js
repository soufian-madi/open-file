const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const root = path.join(__dirname, "..")

test("renders every Text item as plain text", () => {
  const qmlFiles = fs.readdirSync(root).filter((file) => file.endsWith(".qml")).sort()
  const textItems = []

  for (const file of qmlFiles) {
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n")

    for (let start = 0; start < lines.length; start++) {
      const match = lines[start].match(/^(\s*)Text \{$/)
      if (!match) continue

      const closingBrace = `${match[1]}}`
      const end = lines.findIndex((line, index) => index > start && line === closingBrace)
      assert.notEqual(end, -1, `unclosed Text item in ${file} at line ${start + 1}`)
      textItems.push({ file, block: lines.slice(start, end + 1).join("\n") })
    }
  }

  assert.ok(textItems.length > 0, "expected at least one Text item")
  for (const item of textItems) {
    assert.match(item.block, /^\s*textFormat: Text\.PlainText$/m, `Text item in ${item.file}`)
  }
})

test("delivers typed input to subprocesses over stdin, never as arguments", () => {
  const qml = fs.readFileSync(path.join(root, "Fzf.qml"), "utf8")

  // Every process fed a command plan — search, completion, state write — must
  // accept stdin and deliver the plan's input when it starts.
  const stdinProcesses = qml.match(/stdinEnabled: true/g) || []
  assert.ok(stdinProcesses.length >= 3,
    "search, completion and state write processes must enable stdin")
  assert.match(qml, /write\(pendingInput\)/)

  // Command builders carry user-typed values in their input, not in argv.
  const SearchCommand = require(path.join(root, "SearchCommand.js"))
  const BoundedFile = require(path.join(root, "BoundedFile.js"))
  const plans = [
    SearchCommand.searchCommand("Private notes/secret", "/home/test", 200, 262144),
    SearchCommand.completionCommand("Private notes/secret", "/home/test", 1, 262144),
    BoundedFile.writeCommand("/tmp/state.json", '{"version":1,"scope":"Private notes/"}\n', 32)
  ]
  for (const plan of plans) {
    assert.ok(plan.input.includes("Private notes"), plan.command)
    assert.ok(!JSON.stringify(plan.command).includes("Private notes"), plan.command)
  }
})
