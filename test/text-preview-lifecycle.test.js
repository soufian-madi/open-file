const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const root = path.join(__dirname, "..")
const fzf = fs.readFileSync(path.join(root, "Fzf.qml"), "utf8")

function functionBody(name) {
  const match = fzf.match(new RegExp(`  function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\}\\n`))
  assert.ok(match, name)
  return `function ${name}(${match[1]}) {${match[2]}\n}`
}

// The textPreviewProc block and its handlers, as written in Fzf.qml.
// Values from the vm realm, compared as plain data.
const plain = value => JSON.parse(JSON.stringify(value))

const procBlock = (fzf.match(/\n  Process \{\n    id: textPreviewProc\n[\s\S]*?\n  \}\n/) || [""])[0]
const startedBody = (procBlock.match(/onStarted: \{([\s\S]*?)\n    \}/) || [])[1]
const exitedBody = (procBlock.match(/onExited: function\(exitCode\) \{([\s\S]*?)\n    \}/) || [])[1]

// A stand-in for Quickshell's Process that reproduces the ordering measured
// with `qs`: after `running = false` and an immediate exec(), the old
// process reports its exit only later, when pendingGen already holds the new
// generation, and the new process starts after that.
function harness(paths) {
  const events = []
  const proc = {
    running: false, pendingGen: 0, startedGen: 0, pendingInput: "", queue: [], stdout: "",
    exec(command) { events.push("exec"); this.queue.push({ command }) },
    write(data) { events.push(["write", data]) }
  }
  Object.defineProperty(proc, "running", {
    get() { return this._running || false },
    set(value) { if (!value && this._running) events.push("kill"); this._running = value && this._running }
  })
  const context = {
    root: {
      previewPath: "", textPreviewPath: "", textPreviewLines: [], textPreviewDone: false,
      textPreviewGen: 0, maxTextPreviewOutputBytes: 131072
    },
    textPreviewProc: proc,
    textPreviewStdout: { get text() { return proc.stdout } },
    textPreviewWatchdog: { stop() { events.push("watchdog stop") }, restart() { events.push("watchdog start") } },
    previewPane: { textLineCapacity: 20, textColumnCapacity: 60 },
    PreviewKind: require(path.join(root, "PreviewKind.js")),
    TextPreview: require(path.join(root, "TextPreview.js")),
    AnsiText: require(path.join(root, "AnsiText.js"))
  }
  vm.createContext(context)
  for (const name of ["refreshTextPreview", "finishTextPreview", "abandonTextPreview"]) {
    vm.runInContext(functionBody(name), context)
    context.root[name] = context[name]
  }
  vm.runInContext(`
    function procStarted() { with (textPreviewProc) {${startedBody}\n} }
    function procExited(exitCode) {${exitedBody}\n}`, context)

  return {
    context, events, proc,
    select(p) { context.root.previewPath = p; vm.runInContext("refreshTextPreview()", context) },
    // The next queued process starts (as Quickshell does once the old one is gone).
    start() { proc.queue.shift(); proc._running = true; vm.runInContext("procStarted()", context) },
    exit(code, out) { proc._running = false; proc.stdout = out; vm.runInContext(`procExited(${code})`, context) }
  }
}

test("the process wiring stamps the generation when a process starts", () => {
  assert.ok(procBlock, "textPreviewProc block")
  assert.match(procBlock, /^\s*stdinEnabled: true$/m)
  assert.match(startedBody, /startedGen = pendingGen\n\s*write\(pendingInput\)\n\s*pendingInput = ""/)
  assert.match(exitedBody, /root\.finishTextPreview\(textPreviewProc\.startedGen, exitCode, textPreviewStdout\.text\)/)
  assert.match(procBlock, /StdioCollector \{\n\s*id: textPreviewStdout\n\s*waitForEnd: true/)
  assert.match(fzf, /Timer \{\n\s*id: textPreviewWatchdog\n\s*interval: root\.textPreviewTimeout\n\s*onTriggered: root\.abandonTextPreview\(\)/)
})

test("starts one process per selection, only through refreshTextPreview", () => {
  // Exactly one place starts it, and only the debounced preview path calls that.
  assert.equal((fzf.match(/textPreviewProc\.exec\(/g) || []).length, 1)
  assert.equal((fzf.match(/textPreviewProc\.running = true/g) || []).length, 0)
  const callers = fzf.split("\n").filter(line => /root\.refreshTextPreview\(\)/.test(line))
  assert.equal(callers.length, 3)
  const schedule = functionBody("schedulePreview")
  // schedulePreview only ever calls it to clear (inside the early return).
  assert.match(schedule, /root\.previewPath = ""\n\s*root\.refreshTextPreview\(\)\n\s*return/)
  assert.match(fzf, /readonly property int textPreviewTimeout: 2500/)
  assert.match(fzf, /readonly property int maxTextPreviewOutputBytes: 131072/)
})

test("sends the path over stdin and shows the parsed answer", () => {
  const h = harness()
  h.select("/home/test/Private notes/plan.py")
  assert.deepEqual(h.events, ["watchdog stop", "exec", "watchdog start"])
  const command = h.proc.queue[0].command
  assert.ok(!JSON.stringify(command).includes("Private notes"))
  assert.equal(command[4], "20", "asks for the pane's line capacity")
  assert.equal(h.proc.pendingGen, h.context.root.textPreviewGen)
  assert.equal(h.context.root.textPreviewDone, false)

  h.start()
  assert.deepEqual(h.events.slice(-1), [["write", "/home/test/Private notes/plan.py\0--file-name='plan.py'\n\0"]])
  h.exit(0, "\x1b[35mdef\x1b[0m f():\n")
  assert.equal(h.context.root.textPreviewDone, true)
  assert.equal(h.context.root.textPreviewPath, "/home/test/Private notes/plan.py")
  assert.deepEqual(plain(h.context.root.textPreviewLines.map(runs => runs.map(r => r.text))), [["def", " f():"]])
})

test("ignores a stale process whose exit arrives after the next request", () => {
  const h = harness()
  h.select("/home/test/a.txt")
  h.start()
  h.select("/home/test/b.txt")
  assert.deepEqual(h.events.slice(-4), ["watchdog stop", "kill", "exec", "watchdog start"])
  // The killed process reports now, with pendingGen already moved on.
  assert.equal(h.proc.pendingGen, h.context.root.textPreviewGen)
  h.exit(15, "stale output of a.txt\n")
  assert.equal(h.context.root.textPreviewDone, false)
  assert.deepEqual(plain(h.context.root.textPreviewLines), [])
  h.start()
  h.exit(0, "fresh b\n")
  assert.equal(h.context.root.textPreviewPath, "/home/test/b.txt")
  assert.deepEqual(plain(h.context.root.textPreviewLines.map(runs => runs.map(r => r.text))), [["fresh b"]])
})

test("runs nothing for non-text kinds, empty selections or the path already shown", () => {
  const h = harness()
  for (const p of ["/home/test/photo.png", "/home/test/Pictures/", "/home/test/song.mp3", "/home/test/doc.pdf", ""]) {
    h.select(p)
    assert.equal(h.context.root.textPreviewDone, true, p)
    assert.deepEqual(plain(h.context.root.textPreviewLines), [], p)
  }
  assert.ok(!h.events.includes("exec"))

  h.select("/home/test/notes.md")
  h.start()
  h.exit(0, "# notes\n")
  const before = h.events.length
  h.select("/home/test/notes.md")
  assert.equal(h.events.length, before, "the same path keeps its answer")
})

test("keeps the placeholder for refusals and timeouts", () => {
  const h = harness()
  h.select("/home/test/data.bin.txt")
  h.start()
  h.exit(65, "")
  assert.equal(h.context.root.textPreviewDone, true)
  assert.deepEqual(plain(h.context.root.textPreviewLines), [])

  h.select("/home/test/slow.txt")
  h.start()
  vm.runInContext("abandonTextPreview()", h.context)
  assert.equal(h.events.slice(-1)[0], "kill")
  assert.equal(h.context.root.textPreviewDone, true)
  // Whatever the killed process still reports is ignored.
  h.exit(0, "late\n")
  assert.deepEqual(plain(h.context.root.textPreviewLines), [])
})

test("clearing the selection stops a running preview at once", () => {
  const h = harness()
  h.select("/home/test/a.txt")
  h.start()
  h.select("")
  assert.equal(h.events.slice(-1)[0], "kill")
  assert.equal(h.context.root.textPreviewPath, "")
  h.exit(0, "late\n")
  assert.deepEqual(plain(h.context.root.textPreviewLines), [])
})

test("reads the palette on open, never per selection", () => {
  assert.match(functionBody("open"), /if \(!paletteProc\.running\) paletteProc\.running = true/)
  assert.equal((fzf.match(/paletteProc\.running = true/g) || []).length, 1)
  assert.match(fzf, /command: TextPreview\.paletteCommand\(root\.maxPaletteBytes\)\.command/)
  assert.match(fzf, /root\.terminalColors = AnsiText\.parsePalette\(paletteStdout\.text\)/)
  assert.match(fzf, /^\s*terminalColors: root\.terminalColors$/m)
})
