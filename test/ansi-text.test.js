const test = require("node:test")
const assert = require("node:assert/strict")

const AnsiText = require("../AnsiText.js")

const E = "\x1b"
// Compact view of parsed lines: "text" for default runs, "c:text" with the
// color, "+b" / "+i" / "+u" / "+d" for attributes.
function view(lines) {
  return lines.map(runs => runs.map(r => {
    const attrs = (r.bold ? "+b" : "") + (r.italic ? "+i" : "") + (r.underline ? "+u" : "") + (r.dim ? "+d" : "")
    return (r.color === -1 ? "" : r.color + ":") + r.text + attrs
  }))
}
const parse = (text, options) => view(AnsiText.parse(text, options))

test("splits plain text into lines without a trailing empty line", () => {
  assert.deepEqual(parse("one\ntwo\n"), [["one"], ["two"]])
  assert.deepEqual(parse("one\ntwo"), [["one"], ["two"]])
  assert.deepEqual(parse("a\n\nb\n"), [["a"], [], ["b"]])
  assert.deepEqual(parse(""), [])
  assert.deepEqual(parse(null), [])
})

test("reads bat's ansi-theme output into colored runs", () => {
  // Captured from bat --theme=ansi on a Python file.
  const bat = `${E}[35mdef${E}[0m ${E}[34mf${E}[0m(${E}[36mx${E}[0m):\n` +
    `    ${E}[35mreturn${E}[0m ${E}[32m"${E}[0m${E}[32mstr${E}[0m${E}[32m"${E}[0m\n`
  assert.deepEqual(parse(bat), [
    ["5:def ", "4:f", "(", "6:x", "):"],
    ["    ", "5:return ", "2:\"str\""]
  ])
})

test("handles every kind of reset", () => {
  assert.deepEqual(parse(`${E}[31mred${E}[0mplain`), [["1:red", "plain"]])
  assert.deepEqual(parse(`${E}[31mred${E}[mplain`), [["1:red", "plain"]])
  assert.deepEqual(parse(`${E}[31mred${E}[39mplain`), [["1:red", "plain"]])
  assert.deepEqual(parse(`${E}[1;3;4;2mx${E}[22my${E}[23mz${E}[24mw`), [["x+b+i+u+d", "y+i+u", "z+u", "w"]])
  assert.deepEqual(parse(`${E}[4mu${E}[4:0mv`), [["u+u", "v"]])
  // A reset inside a parameter list clears what came before it.
  assert.deepEqual(parse(`${E}[1;31;0;32mx`), [["2:x"]])
})

test("combines nested and adjacent codes and merges equal neighbors", () => {
  assert.deepEqual(parse(`${E}[1;33mbold yellow${E}[0m`), [["3:bold yellow+b"]])
  assert.deepEqual(parse(`${E}[31m${E}[1mB${E}[0m`), [["1:B+b"]])
  assert.deepEqual(parse(`${E}[32ma${E}[0m${E}[32mb${E}[0m`), [["2:ab"]])
  assert.deepEqual(parse(`${E}[32ma${E}[33mb${E}[34mc`), [["2:a", "3:b", "4:c"]])
  // A later color replaces an earlier one; bold survives a color change.
  assert.deepEqual(parse(`${E}[1;31ma${E}[32mb`), [["1:a+b", "2:b+b"]])
})

test("lets spaces join the run before them unless it is underlined", () => {
  assert.deepEqual(parse(`${E}[35mimport${E}[0m os`), [["5:import", " os"]])
  assert.deepEqual(parse(`${E}[35mdef${E}[0m ${E}[34mf`), [["5:def ", "4:f"]])
  assert.deepEqual(parse(`${E}[4;35mdef${E}[0m ${E}[34mf`), [["5:def+u", " ", "4:f"]])
  assert.deepEqual(parse(`    ${E}[35mreturn`), [["    ", "5:return"]])
})

test("maps bright, 256-color and truecolor foregrounds", () => {
  assert.deepEqual(parse(`${E}[90ma${E}[97mb`), [["8:a", "15:b"]])
  assert.deepEqual(parse(`${E}[38;5;3ma${E}[38;5;12mb`), [["3:a", "12:b"]])
  assert.deepEqual(parse(`${E}[38;5;196ma${E}[38;5;232mb${E}[38;5;255mc`), [["#ff0000:a", "#080808:b", "#eeeeee:c"]])
  assert.deepEqual(parse(`${E}[38;2;1;2;255ma`), [["#0102ff:a"]])
  assert.deepEqual(parse(`${E}[38:2::10:20:30ma${E}[38:5:4mb`), [["#0a141e:a", "4:b"]])
  assert.equal(AnsiText.color256(16), "#000000")
  assert.equal(AnsiText.color256(231), "#ffffff")
  assert.equal(AnsiText.color256(7), 7)
})

test("consumes background colors without touching the foreground", () => {
  assert.deepEqual(parse(`${E}[31;48;5;2mx`), [["1:x"]])
  assert.deepEqual(parse(`${E}[48;2;1;2;3;32mx`), [["2:x"]])
  assert.deepEqual(parse(`${E}[41;44;49;35mx`), [["5:x"]])
  assert.deepEqual(parse(`${E}[58;5;1;34mx`), [["4:x"]])
})

test("ignores unknown and malformed codes", () => {
  assert.deepEqual(parse(`${E}[5;7;8;53;999mx`), [["x"]])
  assert.deepEqual(parse(`${E}[31m${E}[38;5;300mx`), [["1:x"]])
  assert.deepEqual(parse(`${E}[31m${E}[38;2;1;2mx`), [["1:x"]])
  assert.deepEqual(parse(`${E}[31m${E}[38;9mx`), [["1:x"]])
  // Private and non-SGR sequences are dropped whole.
  assert.deepEqual(parse(`a${E}[2Kb${E}[?25lc${E}[1;31Hd${E}[>4;1me`), [["abcde"]])
  // OSC hyperlinks (BEL or ST terminated), charset selection, keypad mode.
  assert.deepEqual(parse(`a${E}]8;;https://x${E}\\b${E}]8;;${E}\\c${E}]0;title\x07d`), [["abcd"]])
  assert.deepEqual(parse(`a${E}(Bb${E}=c${E}Pq data${E}\\d`), [["abcd"]])
})

test("drops escape sequences cut off by the output limit", () => {
  assert.deepEqual(parse(`abc${E}`), [["abc"]])
  assert.deepEqual(parse(`abc${E}[`), [["abc"]])
  assert.deepEqual(parse(`abc${E}[38;5`), [["abc"]])
  assert.deepEqual(parse(`abc${E}]8;;https://exam`), [["abc"]])
  assert.deepEqual(parse(`abc${E}(`), [["abc"]])
  // A broken sequence ends at the first byte that cannot belong to it, and
  // the text from there on survives.
  assert.deepEqual(parse(`${E}[31mred${E}[3\nnext`), [["1:red"], ["1:next"]])
})

test("never lets a control character reach the runs", () => {
  assert.deepEqual(parse("a\x01b\x07c\x7fd\x85e\x9bf"), [["a�b�c�d�e�f"]])
  assert.deepEqual(parse("crlf\r\nnext\r\n"), [["crlf"], ["next"]])
  assert.deepEqual(parse("lone\rcr"), [["lone�cr"]])
  assert.deepEqual(parse("a\tb\n\tc\nabcd\te"), [["a   b"], ["    c"], ["abcd    e"]])
  assert.deepEqual(parse("ab\tc", { tabWidth: 8 }), [["ab      c"]])

  // Fuzz: whatever bytes arrive, runs hold only printable text.
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const alphabet = ["\x1b", "[", "]", "\\", ";", ":", "m", "3", "8", "5", "2", "\x07", "\t", "\n", "\r",
    "\x00", "\x01", "\x7f", "\x9b", "a", " ", "é", "🎉", "?", "("]
  for (let round = 0; round < 500; round++) {
    let input = ""
    for (let i = 0; i < 60; i++) input += alphabet[Math.floor(random() * alphabet.length)]
    for (const runs of AnsiText.parse(input)) {
      for (const run of runs) {
        assert.doesNotMatch(run.text, /[\x00-\x1f\x7f-\x9f]/, JSON.stringify(input))
        assert.notEqual(run.text, "")
      }
    }
  }
})

test("keeps only the lines and columns that fit", () => {
  assert.deepEqual(parse("1\n2\n3\n4\n", { maxLines: 2 }), [["1"], ["2"]])
  assert.deepEqual(parse("abcdef\nxy", { maxColumns: 4 }), [["abcd"], ["xy"]])
  assert.deepEqual(parse(`${E}[31mab${E}[32mcd${E}[33mef`, { maxColumns: 3 }), [["1:ab", "2:c"]])
  // Escapes past the visible columns still carry their style to the next line.
  assert.deepEqual(parse(`abc${E}[34mdef\nnext`, { maxColumns: 2 }), [["ab"], ["4:ne"]])
  // A cut never leaves half of a surrogate pair.
  assert.deepEqual(parse("a🎉b", { maxColumns: 2 }), [["a"]])
  assert.deepEqual(parse("a🎉b", { maxColumns: 3 }), [["a🎉"]])
  // Tabs count toward the columns once expanded.
  assert.deepEqual(parse("\tabc", { maxColumns: 5 }), [["    a"]])
})

test("reads the 16-color terminal palette from omarchy-theme-color", () => {
  const raw = [
    "accent\t#7daea3", "background\t#282828", "color0\t#282828", "color1\t#EA6962",
    "color10\t#a9b665", "color15\t#d4be98", "color16\t#000000", "color7\tnot-a-color",
    "color8 #665c54", "mode\tdark", ""
  ].join("\n")
  const palette = AnsiText.parsePalette(raw)
  assert.equal(palette.length, 16)
  assert.equal(palette[0], "#282828")
  assert.equal(palette[1], "#ea6962")
  assert.equal(palette[10], "#a9b665")
  assert.equal(palette[15], "#d4be98")
  // Malformed lines and unknown keys leave the default text color.
  assert.equal(palette[7], "")
  assert.equal(palette[8], "")
  assert.deepEqual(AnsiText.parsePalette(""), new Array(16).fill(""))
})
