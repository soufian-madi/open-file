const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const TextPreview = require("../TextPreview.js")
const AnsiText = require("../AnsiText.js")

const has = tool => spawnSync("bash", ["-c", `command -v ${tool}`]).status === 0
const toolsMissing = ["bat", "file", "timeout"].filter(tool => !has(tool))
const needsTools = toolsMissing.length ? `needs ${toolsMissing.join(", ")}` : false

function run(plan, env = process.env) {
  return spawnSync(plan.command[0], plan.command.slice(1), { input: plan.input, env, timeout: 10000 })
}

function makeDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "open-file-text-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

const colored = out => /\x1b\[3[0-7]m/.test(out.toString())

test("keeps the selected path and file name off the command line", () => {
  const selected = "/home/test/Private notes/secret plan.md"
  const plan = TextPreview.previewCommand(selected, { maxLines: 30 })
  assert.deepEqual(plan.command.slice(0, 2), ["bash", "-c"])
  assert.equal(plan.command[2], TextPreview.previewScript)
  for (const arg of plan.command) {
    assert.ok(!arg.includes("Private notes"), arg)
    assert.ok(!arg.includes("secret plan"), arg)
  }
  // Everything after the script name is a plain number.
  for (const arg of plan.command.slice(4)) assert.match(arg, /^[1-9][0-9]*$/)
  // The path and a bat config line naming the file travel over stdin.
  assert.equal(plan.input, selected + "\0" + "--file-name='secret plan.md'\n\0")
})

test("uses the path only as a redirect or a test inside the script", () => {
  // A path in any command's argv would be world-readable in /proc/<pid>/cmdline.
  const uses = TextPreview.previewScript.split("\n").filter(line => /\$\{?path\b/.test(line))
  assert.deepEqual(uses, [
    "[[ -f $path && -r $path ]] || exit 66",
    "[[ -s $path ]] || exit 67",
    "encoding=$(head -c \"$max_input\" < \"$path\" 2>/dev/null |",
    "head -c \"$max_input\" < \"$path\" 2>/dev/null |"
  ])
  assert.doesNotMatch(TextPreview.previewScript, /--file-name|\$name/)
})

test("states every output-shaping bat option and every limit", () => {
  const script = TextPreview.previewScript
  for (const option of ["--color=always", "--style=plain", "--theme=ansi", "--paging=never",
    "--wrap=never", "--tabs=4", "--binary=no-printing", "--line-range=\":$max_lines\""]) {
    assert.ok(script.includes(option), option)
  }
  assert.match(script, /unset "\$\{!BAT_@\}"/)
  assert.match(script, /export BAT_CONFIG_PATH=\/dev\/fd\/3/)
  assert.match(script, /head -c "\$max_input" < "\$path"[\s\S]*head -n "\$max_lines"[\s\S]*cut -b "1-\$max_columns"/)
  assert.match(script, /timeout -k 1 "\$seconds" file /)
  assert.match(script, /timeout -k 1 "\$seconds" bat /)
  assert.match(script, /\| *\n? *head -c "\$max_output"/)

  const plan = TextPreview.previewCommand("/home/test/a.txt", {
    maxLines: 25, maxColumns: 300, maxInputBytes: 4096, maxOutputBytes: 8192, seconds: 3 })
  assert.deepEqual(plan.command.slice(4), ["25", "300", "4096", "8192", "3"])
  // Missing or nonsense limits fall back to the defaults; lines are capped.
  const fallback = TextPreview.previewCommand("/home/test/a.txt", { maxLines: -1, maxColumns: NaN, seconds: "x" })
  const d = TextPreview.defaults
  assert.deepEqual(fallback.command.slice(4),
    [d.maxLines, d.maxColumns, d.maxInputBytes, d.maxOutputBytes, d.seconds].map(String))
  assert.equal(TextPreview.previewCommand("/a", { maxLines: 100000 }).command[4], String(TextPreview.lineCeiling))
})

test("quotes the file name as one line of bat config", () => {
  assert.equal(TextPreview.fileNameConfig("/home/test/notes.md"), "--file-name='notes.md'\n")
  assert.equal(TextPreview.fileNameConfig("/home/test/it's.py"), "--file-name='it'\\''s.py'\n")
  assert.equal(TextPreview.fileNameConfig("/home/test/a\nb\rc.py"), "--file-name='a b c.py'\n")
  assert.equal(TextPreview.fileNameConfig("/home/test/dir/"), "--file-name='dir'\n")
  assert.equal(TextPreview.fileNameConfig("/home/test/nul\0.py"), "--file-name='nul.py'\n")
})

test("rejects limits the script cannot trust", { skip: needsTools }, t => {
  const directory = makeDir(t)
  const file = path.join(directory, "a.txt")
  fs.writeFileSync(file, "text\n")
  const plan = TextPreview.previewCommand(file)
  for (const bad of [["0", "1", "1", "1", "1"], ["1;id", "1", "1", "1", "1"], ["1", "1", "1", "1", "0.5"]]) {
    const result = spawnSync("bash", ["-c", TextPreview.previewScript, "bash", ...bad], { input: plan.input })
    assert.equal(result.status, 64, bad.join(" "))
  }
})

test("renders text files in the eight basic colors", { skip: needsTools }, t => {
  const directory = makeDir(t)
  const file = path.join(directory, "it's a \"test\".py")
  fs.writeFileSync(file, "import os\n\ndef f(x):\n\treturn \"s\" + 42\n")
  const result = run(TextPreview.previewCommand(file, { maxLines: 10 }))
  assert.equal(result.status, 0, result.stderr.toString())
  assert.ok(colored(result.stdout), "the file name reached bat, so Python syntax applied")
  for (const code of result.stdout.toString().match(/\x1b\[[0-9;]*m/g)) {
    assert.match(code, /^\x1b\[(0|1|1;)?(3[0-7])?m$/, JSON.stringify(code))
  }
  const lines = AnsiText.parse(result.stdout.toString())
  assert.equal(lines.length, 4)
  assert.equal(lines[3].map(run => run.text).join(""), "    return \"s\" + 42")

  // Names without an extension still pick their syntax.
  const makefile = path.join(directory, "Makefile")
  fs.writeFileSync(makefile, "all:\n\tcc -o app main.c\n")
  assert.ok(colored(run(TextPreview.previewCommand(makefile)).stdout))
})

test("ignores the user's bat configuration and environment", { skip: needsTools }, t => {
  const directory = makeDir(t)
  const file = path.join(directory, "a.py")
  fs.writeFileSync(file, "def f(x):\n\treturn x\n")
  const config = path.join(directory, "config")
  fs.writeFileSync(config, "--style=full\n--paging=always\n--wrap=character\n--terminal-width=10\n")
  const clean = run(TextPreview.previewCommand(file))
  const hostile = run(TextPreview.previewCommand(file), Object.assign({}, process.env, {
    BAT_CONFIG_PATH: config, BAT_STYLE: "full", BAT_THEME: "Monokai Extended", BAT_PAGER: "less",
    BAT_PAGING: "always", BAT_TABS: "8", BAT_OPTS: "--style=full --decorations=always"
  }))
  assert.equal(clean.status, 0)
  assert.equal(hostile.status, 0, hostile.stderr.toString())
  assert.equal(hostile.stdout.toString(), clean.stdout.toString())
})

test("keeps binaries, empty, missing and special files out", { skip: needsTools }, t => {
  const directory = makeDir(t)
  const write = (name, data) => { const p = path.join(directory, name); fs.writeFileSync(p, data); return p }
  const cases = [
    [write("program.dat", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1, 2, 3, 0, 0])), 65],
    [write("nul.txt", "text\0with a NUL byte\n"), 65],
    [write("controls.txt", "bell \x01\x02\x03 text\n"), 65],
    [write("utf16.txt", Buffer.from("\ufeffhello\n", "utf16le")), 65],
    [write("empty.txt", ""), 67],
    [path.join(directory, "missing.txt"), 66],
    [directory, 66]
  ]
  const fifo = path.join(directory, "pipe.txt")
  if (spawnSync("mkfifo", [fifo]).status === 0) cases.push([fifo, 66])
  for (const [file, status] of cases) {
    const result = run(TextPreview.previewCommand(file))
    assert.equal(result.status, status, path.basename(file))
    assert.equal(result.stdout.length, 0, path.basename(file))
  }
})

test("neutralizes control characters and line endings before bat", { skip: needsTools }, t => {
  const directory = makeDir(t)
  // ESC and BEL are text to file(1) ("with escape sequences"), so this file
  // is shown. Its own color codes must not come out as bat's colors.
  const file = path.join(directory, "colored.txt")
  fs.writeFileSync(file, "\x1b[31mRED\x1b[0m done\x07\r\nmid\rline\r\n")
  const result = run(TextPreview.previewCommand(file))
  assert.equal(result.status, 0, result.stderr.toString())
  assert.ok(!result.stdout.includes("\r"))
  const lines = AnsiText.parse(result.stdout.toString())
  assert.deepEqual(lines.map(runs => runs.map(run => [run.color, run.text])), [
    [[-1, "\ufffd[31mRED\ufffd[0m done\ufffd"]],
    [[-1, "mid\ufffdline"]]
  ])

  const invalid = path.join(directory, "latin1.txt")
  fs.writeFileSync(invalid, Buffer.from("caf\xe9 \xff\xfe ok\n", "latin1"))
  const latin = run(TextPreview.previewCommand(invalid))
  assert.equal(latin.status, 0)
  assert.match(latin.stdout.toString(), /caf\ufffd \ufffd\ufffd ok/)
})

test("bounds huge files, minified lines and the output", { skip: needsTools }, t => {
  const directory = makeDir(t)
  const huge = path.join(directory, "huge.log")
  const line = "2026-11-08T12:00:00 INFO worker processed request status=200\n"
  fs.writeFileSync(huge, line.repeat(400000)) // ~25 MB
  const minified = path.join(directory, "app.min.js")
  fs.writeFileSync(minified, "var a=function(b){return b*2};".repeat(100000)) // 3 MB, one line

  let started = process.hrtime.bigint()
  const big = run(TextPreview.previewCommand(huge, { maxLines: 30 }))
  const bigMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(big.status, 0)
  assert.equal(AnsiText.parse(big.stdout.toString()).length, 30)
  assert.ok(bigMs < 2000, `${bigMs} ms`)

  started = process.hrtime.bigint()
  const min = run(TextPreview.previewCommand(minified, { maxColumns: 200 }))
  const minMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(min.status, 0)
  const minLines = AnsiText.parse(min.stdout.toString())
  assert.equal(minLines.length, 1)
  assert.equal(minLines[0].map(run => run.text).join("").length, 200)
  assert.ok(minMs < 2000, `${minMs} ms`)

  const capped = run(TextPreview.previewCommand(huge, { maxLines: 100, maxOutputBytes: 1000 }))
  assert.equal(capped.status, 0, "bat stopped by the output limit is not an error")
  assert.equal(capped.stdout.length, 1000)
})

test("reads the terminal palette through a bounded, argument-free command", t => {
  const plan = TextPreview.paletteCommand(64)
  assert.deepEqual(plan.command.slice(0, 2), ["bash", "-c"])
  assert.deepEqual(plan.command.slice(3), ["bash", "64"])
  assert.equal(plan.input, "")
  assert.equal(TextPreview.paletteCommand("nonsense").command[4], "16384")

  // A stand-in omarchy-theme-color shows the limit and the exit status.
  const bin = makeDir(t)
  const stub = path.join(bin, "omarchy-theme-color")
  fs.writeFileSync(stub, "#!/bin/bash\n[[ $1 == --all ]] || exit 3\nfor i in $(seq 0 15); do printf 'color%s\\t#0000%02x\\n' $i $i; done\n")
  fs.chmodSync(stub, 0o755)
  const env = Object.assign({}, process.env, { PATH: bin + ":" + process.env.PATH })
  const full = run(TextPreview.paletteCommand(16384), env)
  assert.equal(full.status, 0)
  assert.equal(AnsiText.parsePalette(full.stdout.toString())[15], "#00000f")
  const limited = run(TextPreview.paletteCommand(64), env)
  assert.equal(limited.stdout.length, 64)
})
