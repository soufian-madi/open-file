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
