const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const SearchCommand = require("../SearchCommand.js")

function run(command, env = process.env) {
  return spawnSync(command[0], command.slice(1), { env, timeout: 5000 })
}

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "open-file-home-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function makeCache(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "open-file-cache-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, "index")
}

function buildIndex(t, directory, cachePath, maxIndexBytes = 4 * 1024 * 1024) {
  const result = run(SearchCommand.indexCommand(directory, cachePath, maxIndexBytes))
  assert.equal(result.status, 0, result.stderr.toString())
}

function indexedPaths(cachePath) {
  return fs.readFileSync(cachePath, "utf8").split("\0").filter(Boolean)
}

function search(query, cachePath, maxResults = 200, env = process.env, maxOutputBytes = 256 * 1024) {
  return run(SearchCommand.searchCommand(query, cachePath, maxResults, maxOutputBytes), env)
}

function resultPaths(stdout) {
  return stdout.toString("utf8").split("\0").filter(Boolean)
}

test("indexes files and folders with hidden entries but without excluded directories", t => {
  const home = makeHome(t)
  fs.mkdirSync(path.join(home, "Adulting", "Tax papers"), { recursive: true })
  fs.writeFileSync(path.join(home, "Adulting", "Tax papers", "report.md"), "")
  fs.writeFileSync(path.join(home, ".hidden.txt"), "")
  fs.mkdirSync(path.join(home, "node_modules", "pkg"), { recursive: true })
  fs.writeFileSync(path.join(home, "node_modules", "pkg", "index.js"), "")
  fs.mkdirSync(path.join(home, ".git", "objects"), { recursive: true })
  fs.writeFileSync(path.join(home, ".git", "objects", "pack"), "")
  fs.mkdirSync(path.join(home, ".cache", "fontconfig"), { recursive: true })
  fs.writeFileSync(path.join(home, ".cache", "fontconfig", "cache"), "")
  const cachePath = makeCache(t)

  buildIndex(t, home, cachePath)

  const entries = indexedPaths(cachePath)
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600)
  assert.ok(entries.includes("Adulting/"))
  assert.ok(entries.includes("Adulting/Tax papers/"))
  assert.ok(entries.includes("Adulting/Tax papers/report.md"))
  assert.ok(entries.includes(".hidden.txt"))
  for (const entry of entries) {
    assert.ok(!entry.includes("node_modules"), entry)
    assert.ok(!entry.includes(".git"), entry)
    assert.ok(!entry.includes(".cache"), entry)
  }
})

test("filters the index and prepends completed scopes to results", t => {
  const home = makeHome(t)
  fs.mkdirSync(path.join(home, "Adulting", "Tax papers"), { recursive: true })
  fs.writeFileSync(path.join(home, "Adulting", "Tax papers", "report.md"), "")
  fs.writeFileSync(path.join(home, "Adulting", "notes.md"), "")
  fs.writeFileSync(path.join(home, "outside-report.md"), "")
  const cachePath = makeCache(t)
  buildIndex(t, path.join(home, "Adulting"), cachePath)

  const result = search("Adulting/rep", cachePath)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.deepEqual(resultPaths(result.stdout), ["Adulting/Tax papers/report.md"])
})

test("lists the whole scope for an empty remainder query", t => {
  const home = makeHome(t)
  fs.mkdirSync(path.join(home, "Adulting", "Tax papers"), { recursive: true })
  fs.writeFileSync(path.join(home, "Adulting", "Tax papers", "report.md"), "")
  fs.writeFileSync(path.join(home, "Adulting", "notes.md"), "")
  const cachePath = makeCache(t)
  buildIndex(t, path.join(home, "Adulting"), cachePath)

  const result = search("Adulting/", cachePath)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.deepEqual(new Set(resultPaths(result.stdout)), new Set([
    "Adulting/Tax papers/", "Adulting/Tax papers/report.md", "Adulting/notes.md"
  ]))
})

test("returns NUL-delimited results independently of user fzf options", t => {
  const home = makeHome(t)
  fs.writeFileSync(path.join(home, "alpha report.txt"), "")
  fs.writeFileSync(path.join(home, "alpha\nnotes.txt"), "")
  fs.writeFileSync(path.join(home, "beta.txt"), "")
  const cachePath = makeCache(t)
  buildIndex(t, home, cachePath)

  const env = { ...process.env, FZF_DEFAULT_OPTS: "--print-query", FZF_DEFAULT_OPTS_FILE: "/missing" }
  const result = search("alpha", cachePath, 10, env)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.deepEqual(new Set(resultPaths(result.stdout)), new Set(["alpha report.txt", "alpha\nnotes.txt"]))
})

test("limits result count", t => {
  const home = makeHome(t)
  for (let index = 0; index < 5; index++) {
    fs.writeFileSync(path.join(home, `match-${index}.txt`), "")
  }
  const cachePath = makeCache(t)
  buildIndex(t, home, cachePath)

  const result = search("match", cachePath, 2)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.equal(resultPaths(result.stdout).length, 2)
})

test("limits output bytes without emitting a partial path", t => {
  const home = makeHome(t)
  for (let index = 0; index < 10; index++) {
    fs.writeFileSync(path.join(home, `bounded-match-${index}.txt`), "")
  }
  const cachePath = makeCache(t)
  buildIndex(t, home, cachePath)

  const result = search("bounded", cachePath, 100, process.env, 45)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.ok(result.stdout.length <= 45)
  assert.equal(result.stdout.at(-1), 0)
  assert.ok(resultPaths(result.stdout).length < 10)
})

test("caps the index byte size without emitting a partial path", t => {
  const home = makeHome(t)
  for (let index = 0; index < 10; index++) {
    fs.writeFileSync(path.join(home, `bounded-index-entry-${index}.txt`), "")
  }
  const cachePath = makeCache(t)

  buildIndex(t, home, cachePath, 45)

  const content = fs.readFileSync(cachePath)
  assert.ok(content.length <= 45)
  assert.equal(content.at(-1), 0)
  assert.ok(indexedPaths(cachePath).length < 10)
})

test("treats no matches as a successful empty result", t => {
  const home = makeHome(t)
  fs.writeFileSync(path.join(home, "alpha.txt"), "")
  const cachePath = makeCache(t)
  buildIndex(t, home, cachePath)

  const result = search("does-not-match", cachePath)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.deepEqual(resultPaths(result.stdout), [])
})

test("reports a missing search index", () => {
  const result = search("anything", "/definitely/not/an/index")

  assert.equal(result.status, 66)
  assert.match(result.stderr.toString(), /Search index is not available/)
})

test("reports an unavailable search directory", () => {
  const result = run(SearchCommand.indexCommand("/definitely/not/a/directory", "/tmp/opencode/never-written"))

  assert.equal(result.status, 66)
  assert.match(result.stderr.toString(), /Directory is not available/)
})
