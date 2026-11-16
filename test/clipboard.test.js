const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vm = require("node:vm")
const { spawnSync } = require("node:child_process")

const root = path.join(__dirname, "..")
const Clipboard = require(path.join(root, "Clipboard.js"))
const qml = fs.readFileSync(path.join(root, "Fzf.qml"), "utf8")

// Runs the paste command with a fake wl-paste first on PATH.
function runWithFakeWlPaste(script, primary, maxBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-file-paste-"))
  try {
    fs.writeFileSync(path.join(dir, "wl-paste"), "#!/bin/bash\n" + script, { mode: 0o755 })
    fs.writeFileSync(path.join(dir, "args"), "")
    const plan = Clipboard.pasteCommand(primary, maxBytes)
    const started = Date.now()
    const result = spawnSync(plan.command[0], plan.command.slice(1), {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_ARGS: path.join(dir, "args") },
      encoding: "utf8",
      timeout: 10000
    })
    return { ...result, elapsed: Date.now() - started, args: fs.readFileSync(path.join(dir, "args"), "utf8") }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test("builds a paste command that carries only a byte limit and the selection", () => {
  const plan = Clipboard.pasteCommand(false, 4096)
  assert.equal(plan.command[0], "bash")
  assert.deepEqual(plan.command.slice(-2), ["4096", "clipboard"])
  assert.equal(plan.input, "")
  assert.deepEqual(Clipboard.pasteCommand(true, 0).command.slice(-2), ["1", "primary"])
})

test("caps an endless clipboard stream at the byte limit", () => {
  const result = runWithFakeWlPaste('echo "$@" > "$FAKE_ARGS"\nexec yes streaming\n', false, 4096)
  assert.equal(result.status, 0)
  assert.equal(Buffer.byteLength(result.stdout), 4096)
  assert.match(result.args, /--no-newline --type text/)
  assert.doesNotMatch(result.args, /--primary/)
})

test("reads the primary selection for middle-click pastes", () => {
  const result = runWithFakeWlPaste('echo "$@" > "$FAKE_ARGS"\nprintf "Docs/a"\n', true, 4096)
  assert.equal(result.stdout, "Docs/a")
  assert.match(result.args, /--primary/)
})

test("ends a clipboard owner that never sends data", () => {
  const result = runWithFakeWlPaste("exec sleep 30\n", false, 4096)
  assert.equal(result.stdout, "")
  assert.ok(result.elapsed < 4000, `took ${result.elapsed} ms`)
})

test("sanitizes pasted text into one bounded line", () => {
  assert.equal(Clipboard.sanitize("Docs/a b\nsecond line", 100), "Docs/a b")
  assert.equal(Clipboard.sanitize("a\r\nb", 100), "a")
  assert.equal(Clipboard.sanitize("a\u0000b\tc\u001bd\u007f", 100), "abcd")
  assert.equal(Clipboard.sanitize("café�", 100), "café")
  assert.equal(Clipboard.sanitize("abcdef", 3), "abc")
  assert.equal(Clipboard.sanitize(undefined, 3), "")
})

test("swallows TextInput's native clipboard reads in the search field", () => {
  const input = qml.match(/\n(\s*)TextInput \{\n[\s\S]*?\n\1\}\n/)[0]
  // Ctrl+V / Shift+Insert: handled before TextInput's keyPressEvent.
  assert.match(input, /if \(event\.matches\(StandardKey\.Paste\)\) \{\s*root\.requestPaste\(fieldRow\.index, false\)\s*event\.accepted = true/)
  // Middle click: a child MouseArea takes the button before TextInput does.
  assert.match(input, /MouseArea \{[\s\S]*?acceptedButtons: Qt\.MiddleButton[\s\S]*?root\.requestPaste\(fieldRow\.index, true\)/)
  assert.match(input, /maximumLength: root\.maxQueryChars/)
  // Nothing in the plugin reads the clipboard through Qt.
  for (const file of fs.readdirSync(root).filter((name) => /\.(qml|js)$/.test(name))) {
    const source = fs.readFileSync(path.join(root, file), "utf8")
    assert.doesNotMatch(source, /\.paste\(|Clipboard\.text|canPaste|clipboard\(\)/, file)
  }
})

function loadFunction(name, context) {
  const body = qml.match(new RegExp(`  function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}\\n`))
  vm.runInContext(`function ${name}(${body[1]}) {${body[2]}\n}`, context)
}

test("inserts only the paste of the current generation into an open overlay", () => {
  const inserted = []
  const context = vm.createContext({
    root: { pasteGen: 5, opened: true, maxQueryChars: 1024 },
    pasteWatchdog: { stop() {} },
    pasteProc: { field: 0 },
    fieldsRepeater: { itemAt() { return { insertText(text) { inserted.push(text) } } } },
    Clipboard
  })
  loadFunction("finishPaste", context)

  vm.runInContext('finishPaste(4, 0, "stale")', context)
  vm.runInContext('finishPaste(5, 1, "failed")', context)
  context.root.opened = false
  vm.runInContext('finishPaste(5, 0, "closed")', context)
  context.root.opened = true
  vm.runInContext('finishPaste(5, 0, "Docs/x\\nmore")', context)

  assert.deepEqual(inserted, ["Docs/x"])
})

test("closing the overlay cancels a pending paste", () => {
  const close = qml.match(/  function close\(\) \{([\s\S]*?)\n  \}\n/)[1]
  assert.match(close, /root\.cancelPaste\(\)/)
  const cancel = qml.match(/  function cancelPaste\(\) \{([\s\S]*?)\n  \}\n/)[1]
  assert.match(cancel, /root\.pasteGen\+\+/)
  assert.match(cancel, /pasteProc\.running = false/)
})
