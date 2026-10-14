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
function open(targetPath, handler, mime = "text/plain") {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "open-file-open-"))
  const log = path.join(bin, "invocations.log")

  fs.writeFileSync(path.join(bin, "xdg-mime"),
    "#!/bin/bash\n" +
    "case \"$1 $2\" in\n" +
    '  "query filetype") printf \'%s\\n\' "$FAKE_MIME" ;;\n' +
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
      FAKE_MIME: mime,
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
  assert.deepEqual(open(target, "opera.desktop", "text/html"), [`xdg-open:${target}`])
  assert.deepEqual(open(target, "other-editor.desktop", "text/javascript"), [`xdg-open:${target}`])
})

test("opens unassociated text and code types in Neovim", () => {
  for (const mime of ["text/plain", "text/javascript", "text/x-python", "application/json",
    "application/xml", "application/javascript", "application/x-shellscript"]) {
    assert.deepEqual(open(target, "", mime), [`foot:nvim -- ${target}`], mime)
  }
})

test("keeps xdg-open for unassociated non-text types and unknown MIME types", () => {
  for (const mime of ["image/png", "application/pdf", "inode/directory", "application/octet-stream", ""]) {
    assert.deepEqual(open(target, "", mime), [`xdg-open:${target}`], mime)
  }
})

test("passes the path as a positional argument", () => {
  const command = OpenCommand.command(target)
  assert.equal(command[0], "bash")
  assert.equal(command[command.length - 1], target)
})
