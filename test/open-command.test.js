const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const OpenCommand = require("../OpenCommand.js")

const target = "/home/test/My Notes/todo list.md"

// Stubs xdg-mime (file association lookup), foot (the terminal) and xdg-open
// so the handler dispatch can be observed without launching anything.
function open(targetPath, handler) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "open-file-open-"))
  const log = path.join(bin, "invocations.log")

  fs.writeFileSync(path.join(bin, "xdg-mime"),
    "#!/bin/bash\n" +
    "case \"$1 $2\" in\n" +
    '  "query filetype") printf \'%s\\n\' "${FAKE_MIME:-text/plain}" ;;\n' +
    '  "query default") printf \'%s\\n\' "$FAKE_HANDLER" ;;\n' +
    "esac\n", { mode: 0o755 })
  for (const name of ["foot", "xdg-open"]) {
    fs.writeFileSync(path.join(bin, name),
      `#!/bin/bash\nprintf '%s\\n' "${name}:$*" >> "$INVOCATION_LOG"\n`, { mode: 0o755 })
  }

  const command = OpenCommand.command(targetPath)
  const result = spawnSync(command[0], command.slice(1), {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_HANDLER: handler,
      INVOCATION_LOG: log
    }
  })
  assert.equal(result.status, 0, result.stderr.toString())

  const invocations = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []
  fs.rmSync(bin, { recursive: true, force: true })
  return invocations
}

test("opens Neovim handlers in the terminal", () => {
  for (const handler of ["nvim.desktop", "neovim.desktop"]) {
    assert.deepEqual(open(target, handler), [`foot:nvim -- ${target}`], handler)
  }
})

test("opens other handlers with xdg-open", () => {
  assert.deepEqual(open(target, "org.gnome.gedit.desktop"), [`xdg-open:${target}`])
  assert.deepEqual(open(target, ""), [`xdg-open:${target}`])
})

test("passes the path as a positional argument", () => {
  const command = OpenCommand.command(target)
  assert.equal(command[0], "bash")
  assert.equal(command[command.length - 1], target)
})
