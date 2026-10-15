const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const SearchCommand = require("../SearchCommand.js")

function run(plan, env = process.env) {
  return spawnSync(plan.command[0], plan.command.slice(1),
    { input: plan.input, env, timeout: 5000 })
}

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "open-file-home-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function search(query, home, maxResults = 200, env = process.env, maxOutputBytes = 256 * 1024) {
  return run(SearchCommand.searchCommand(query, home, maxResults, maxOutputBytes), env)
}

function resultPaths(stdout) {
  return stdout.toString("utf8").split("\0").filter(Boolean)
}

test("searches files and folders with hidden entries but without excluded directories", t => {
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
  const result = search("", home)
  assert.equal(result.status, 0, result.stderr.toString())
  const entries = resultPaths(result.stdout)
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

test("searches completed scopes and prepends them to results", t => {
  const home = makeHome(t)
  fs.mkdirSync(path.join(home, "Adulting", "Tax papers"), { recursive: true })
  fs.writeFileSync(path.join(home, "Adulting", "Tax papers", "report.md"), "")
  fs.writeFileSync(path.join(home, "Adulting", "notes.md"), "")
  fs.writeFileSync(path.join(home, "outside-report.md"), "")
  const result = search("Adulting/rep", home)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.deepEqual(resultPaths(result.stdout), ["Adulting/Tax papers/report.md"])
})

test("lists the whole scope for an empty remainder query", t => {
  const home = makeHome(t)
  fs.mkdirSync(path.join(home, "Adulting", "Tax papers"), { recursive: true })
  fs.writeFileSync(path.join(home, "Adulting", "Tax papers", "report.md"), "")
  fs.writeFileSync(path.join(home, "Adulting", "notes.md"), "")
  const result = search("Adulting/", home)

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
  const env = { ...process.env, FZF_DEFAULT_OPTS: "--print-query", FZF_DEFAULT_OPTS_FILE: "/missing" }
  const result = search("alpha", home, 10, env)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.deepEqual(new Set(resultPaths(result.stdout)), new Set(["alpha report.txt", "alpha\nnotes.txt"]))
})

test("limits result count", t => {
  const home = makeHome(t)
  for (let index = 0; index < 5; index++) {
    fs.writeFileSync(path.join(home, `match-${index}.txt`), "")
  }
  const result = search("match", home, 2)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.equal(resultPaths(result.stdout).length, 2)
})

test("limits output bytes without emitting a partial path", t => {
  const home = makeHome(t)
  for (let index = 0; index < 10; index++) {
    fs.writeFileSync(path.join(home, `bounded-match-${index}.txt`), "")
  }
  const result = search("bounded", home, 100, process.env, 45)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.ok(result.stdout.length <= 45)
  assert.equal(result.stdout.at(-1), 0)
  assert.ok(resultPaths(result.stdout).length < 10)
})

test("treats no matches as a successful empty result", t => {
  const home = makeHome(t)
  fs.writeFileSync(path.join(home, "alpha.txt"), "")
  const result = search("does-not-match", home)

  assert.equal(result.status, 0, result.stderr.toString())
  assert.deepEqual(resultPaths(result.stdout), [])
})

test("reports an unavailable search directory", () => {
  const result = search("a", "/definitely/not/a/directory")

  assert.equal(result.status, 66)
  assert.match(result.stderr.toString(), /Directory is not available/)
})

test("treats fzf option syntax in queries as literal text", t => {
  const home = makeHome(t)
  const hostile = ["x' --print-query 'y", "back\\slash'd \"q\"", "--filter=pwned", "a b c"]
  for (const query of hostile) fs.writeFileSync(path.join(home, query + ".txt"), "")

  // fd's own spellings of every entry, used as the candidate stream below.
  const everything = resultPaths(search("", home).stdout)
  assert.ok(everything.length >= hostile.length)

  for (const query of hostile) {
    const result = search(query, home)
    assert.equal(result.status, 0, result.stderr.toString())
    const viaPipeline = resultPaths(result.stdout)
    assert.ok(viaPipeline.length > 0, query)
    // An injected option such as --print-query would emit the query itself or
    // otherwise change the result set.
    assert.ok(!viaPipeline.includes(query), query)

    // The same candidates filtered the old way — the query as a plain
    // argument — must give the same matches. The transport may not change
    // fzf's matching semantics, including its option-like query text.
    const direct = spawnSync("fzf", ["--scheme=path", "--read0", "--print0", "--filter=" + query], {
      input: everything.join("\0") + "\0",
      env: { ...process.env, FZF_DEFAULT_OPTS: "", FZF_DEFAULT_OPTS_FILE: "" },
      timeout: 5000
    })
    assert.equal(direct.status, 0, direct.stderr.toString())
    assert.deepEqual(new Set(viaPipeline), new Set(resultPaths(direct.stdout)), query)
  }
})

test("keeps queries, folder scopes and the search root off every command line", t => {
  const home = makeHome(t)
  fs.mkdirSync(path.join(home, "Private notes"), { recursive: true })
  fs.writeFileSync(path.join(home, "Private notes", "secret plan.md"), "")

  // Stub fd/fzf record what /proc exposes to other local users while a search
  // runs: their argv, their own cmdline and environ, and their parent shell's.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "open-file-stubs-"))
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }))
  const log = path.join(bin, "procfs.log")
  const stub =
    "#!/bin/bash\n" +
    "{\n" +
    "  printf 'args:'; printf '<%s>' \"$@\"; printf '\\n'\n" +
    "  printf 'self cmdline:'; tr '\\0' ' ' < /proc/self/cmdline; printf '\\n'\n" +
    "  printf 'self environ:\\n'; tr '\\0' '\\n' < /proc/self/environ\n" +
    "  printf 'parent cmdline:'; tr '\\0' ' ' < \"/proc/$PPID/cmdline\"; printf '\\n'\n" +
    "  printf 'parent environ:\\n'; tr '\\0' '\\n' < \"/proc/$PPID/environ\"\n" +
    "} >> \"$OPEN_FILE_TEST_LOG\"\n"
  for (const name of ["fd", "fzf"]) {
    const file = path.join(bin, name)
    fs.writeFileSync(file, stub)
    fs.chmodSync(file, 0o755)
  }

  const query = "Private notes/secret plan 'quoted' --print-query"
  const plan = SearchCommand.searchCommand(query, home, 200, 262144)
  const secrets = ["secret plan", "Private notes", query, home]

  // The typed values reach the subprocess ...
  for (const secret of ["secret plan", "Private notes", home])
    assert.ok(plan.input.includes(secret), secret)
  // ... but never through the command line.
  for (const secret of secrets)
    assert.ok(!JSON.stringify(plan.command).includes(secret), secret)

  const result = run(plan, {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    OPEN_FILE_TEST_LOG: log
  })
  assert.equal(result.status, 0, result.stderr.toString())

  const observed = fs.readFileSync(log, "utf8")
  assert.ok(observed.includes("self cmdline:"), "stubs must record their command lines")
  for (const secret of secrets)
    assert.ok(!observed.includes(secret), `leaked to a command line or environment: ${secret}`)
})
