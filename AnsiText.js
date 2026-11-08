// Turns bat's colored output into styled runs that plain-text items can draw,
// and reads the theme's 16-color terminal palette. Pure string work, so it
// runs under node for the tests and in QML unchanged.
//
// Nothing here produces markup. The pane draws every run with a
// Text.PlainText item and sets its color from the run's style, so file
// content can never be interpreted as rich text.
//
// bat with the "ansi" theme emits only SGR resets and the eight basic colors
// (measured: 0, 31-36 and 1;33 across 400 files of many syntaxes), but the
// parser accepts the whole SGR vocabulary a terminal would: bold, dim,
// italic, underline, bright colors, 256-color and truecolor. Background
// colors are consumed and ignored; the pane keeps its own surface. Any other
// escape sequence is dropped, and a sequence cut off by the output byte
// limit is dropped too.
//
// Each run is { text, color, bold, dim, italic, underline }, where color is
// -1 for the default text color, 0-15 for a palette entry, or "#rrggbb".

var replacement = "�"

function defaultStyle() {
  return { color: -1, bold: false, dim: false, italic: false, underline: false }
}

function copyStyle(style) {
  return { color: style.color, bold: style.bold, dim: style.dim, italic: style.italic, underline: style.underline }
}

function sameStyle(a, b) {
  return a.color === b.color && a.bold === b.bold && a.dim === b.dim
    && a.italic === b.italic && a.underline === b.underline
}

function hex2(value) {
  var s = Math.max(0, Math.min(255, value | 0)).toString(16)
  return s.length < 2 ? "0" + s : s
}

// xterm's 256-color table: 0-15 are the palette, then a 6x6x6 cube and a
// 24-step gray ramp.
function color256(n) {
  if (n < 16) return n
  if (n < 232) {
    var levels = [0, 95, 135, 175, 215, 255]
    var i = n - 16
    return "#" + hex2(levels[Math.floor(i / 36)]) + hex2(levels[Math.floor(i / 6) % 6]) + hex2(levels[i % 6])
  }
  var gray = 8 + (n - 232) * 10
  return "#" + hex2(gray) + hex2(gray) + hex2(gray)
}

function isByte(value) {
  return isFinite(value) && value >= 0 && value <= 255 && Math.floor(value) === value
}

// Reads an extended color (38/48/58) starting at params[i]. Returns how many
// parameters it used and the color, or null when it is malformed. Accepts
// both "38;5;n" and the colon form "38:5:n" / "38:2::r:g:b".
function extendedColor(params, i) {
  var head = params[i]
  if (head.indexOf(":") >= 0) {
    var parts = head.split(":").map(function(p) { return p === "" ? NaN : Number(p) })
    if (parts[1] === 5 && isByte(parts[2])) return { used: 1, color: color256(parts[2]) }
    if (parts[1] === 2) {
      // With a color-space id the components start one later: 38:2::r:g:b.
      var rgb = parts.length >= 6 ? parts.slice(3, 6) : parts.slice(2, 5)
      if (rgb.length === 3 && rgb.every(isByte))
        return { used: 1, color: "#" + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]) }
    }
    return { used: 1, color: null }
  }
  var mode = Number(params[i + 1])
  if (mode === 5) {
    var n = Number(params[i + 2])
    return { used: 3, color: isByte(n) ? color256(n) : null }
  }
  if (mode === 2) {
    var r = Number(params[i + 2]), g = Number(params[i + 3]), b = Number(params[i + 4])
    return { used: 5, color: isByte(r) && isByte(g) && isByte(b) ? "#" + hex2(r) + hex2(g) + hex2(b) : null }
  }
  return { used: params.length - i, color: null }
}

// Applies one SGR parameter string ("", "0", "1;33", "38;5;208"...) to style.
function applySgr(style, paramText) {
  var params = paramText === "" ? ["0"] : paramText.split(";")
  for (var i = 0; i < params.length; i++) {
    var raw = params[i]
    var head = raw.split(":")[0]
    var code = head === "" ? 0 : Number(head)
    if (!isFinite(code)) continue
    if (code === 0) {
      style.color = -1; style.bold = false; style.dim = false
      style.italic = false; style.underline = false
    } else if (code === 1) style.bold = true
    else if (code === 2) style.dim = true
    else if (code === 3) style.italic = true
    // "4:0" is the colon form of "underline off"; 4:1-4:5 are underline styles.
    else if (code === 4) style.underline = raw !== "4:0"
    else if (code === 21) style.underline = true
    else if (code === 22) { style.bold = false; style.dim = false }
    else if (code === 23) style.italic = false
    else if (code === 24) style.underline = false
    else if (code >= 30 && code <= 37) style.color = code - 30
    else if (code >= 90 && code <= 97) style.color = code - 90 + 8
    else if (code === 39) style.color = -1
    else if (code === 38 || code === 48 || code === 58) {
      var ext = extendedColor(params, i)
      if (code === 38 && ext.color !== null) style.color = ext.color
      i += ext.used - 1
    }
    // Everything else (backgrounds, blink, inverse, fonts...) is ignored.
  }
}

// Escape sequence at text[start] (an ESC). Returns { end, sgr } where end is
// the index after the sequence and sgr is the parameter string of a complete
// SGR sequence, or null for anything else. A sequence cut off by the end of
// the text consumes the rest of it.
function readEscape(text, start) {
  var n = text.length
  var next = start + 1
  if (next >= n) return { end: n, sgr: null }
  var c = text.charAt(next)
  if (c === "[") {
    var i = next + 1
    var paramStart = i
    while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x3f) i++
    var paramEnd = i
    while (i < n && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i++
    if (i >= n) return { end: n, sgr: null }
    var final = text.charCodeAt(i)
    // A byte that cannot end a CSI sequence ends it malformed: drop what was
    // read and resume at that byte, so text after a broken code survives.
    if (final < 0x40 || final > 0x7e) return { end: i, sgr: null }
    var params = text.slice(paramStart, paramEnd)
    var plain = paramEnd === i && /^[0-9;:]*$/.test(params)
    return { end: i + 1, sgr: text.charAt(i) === "m" && plain ? params : null }
  }
  if (c === "]" || c === "P" || c === "X" || c === "^" || c === "_") {
    // OSC / DCS / SOS / PM / APC strings run to BEL (OSC only) or ST (ESC \).
    for (var j = next + 1; j < n; j++) {
      if (c === "]" && text.charAt(j) === "\x07") return { end: j + 1, sgr: null }
      if (text.charAt(j) === "\x1b" && text.charAt(j + 1) === "\\") return { end: j + 2, sgr: null }
    }
    return { end: n, sgr: null }
  }
  // Two-character (or intermediate + final) escapes such as ESC ( B.
  var k = next
  while (k < n && text.charCodeAt(k) >= 0x20 && text.charCodeAt(k) <= 0x2f) k++
  if (k >= n) return { end: n, sgr: null }
  var code = text.charCodeAt(k)
  return { end: code >= 0x30 && code <= 0x7e ? k + 1 : k, sgr: null }
}

// Control characters that would otherwise reach a Text item. Tabs become
// spaces to the next stop of tabWidth; everything else becomes U+FFFD.
function isControl(code) {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

// parse(text, { maxLines, maxColumns, tabWidth }) -> array of lines, each an
// array of runs. Lines are split on "\n"; a trailing newline does not start
// an empty last line, and a "\r" before it is dropped. Text past maxColumns
// UTF-16 code units of a line is not kept (the pane clips it anyway), but
// escape codes there still update the style. Adjacent runs of equal style
// are merged, and a run of spaces joins the run before it when that run is
// not underlined, so a line needs as few items as its colors allow.
function parse(raw, options) {
  var text = String(raw === undefined || raw === null ? "" : raw)
  var opts = options || {}
  var maxLines = opts.maxLines > 0 ? Math.floor(opts.maxLines) : Infinity
  var maxColumns = opts.maxColumns > 0 ? Math.floor(opts.maxColumns) : Infinity
  var tabWidth = opts.tabWidth > 0 ? Math.floor(opts.tabWidth) : 4

  var lines = []
  var runs = []
  var column = 0
  var style = defaultStyle()
  var pending = ""
  var pendingStyle = copyStyle(style)

  function flush() {
    if (pending === "") return
    var last = runs.length > 0 ? runs[runs.length - 1] : null
    if (last && (sameStyle(last, pendingStyle) || (/^ +$/.test(pending) && !last.underline))) {
      last.text += pending
    } else {
      runs.push({ text: pending, color: pendingStyle.color, bold: pendingStyle.bold,
        dim: pendingStyle.dim, italic: pendingStyle.italic, underline: pendingStyle.underline })
    }
    pending = ""
  }

  function append(s) {
    if (column >= maxColumns) return
    if (s.length > maxColumns - column) {
      s = s.slice(0, maxColumns - column)
      // Never leave half of a surrogate pair at the cut.
      var tail = s.charCodeAt(s.length - 1)
      if (tail >= 0xd800 && tail <= 0xdbff) s = s.slice(0, -1)
    }
    if (s === "") return
    if (!sameStyle(style, pendingStyle)) {
      flush()
      pendingStyle = copyStyle(style)
    }
    pending += s
    column += s.length
  }

  function endLine() {
    flush()
    lines.push(runs)
    runs = []
    column = 0
  }

  var i = 0
  var n = text.length
  while (i < n && lines.length < maxLines) {
    var code = text.charCodeAt(i)
    if (code === 0x1b) {
      var esc = readEscape(text, i)
      if (esc.sgr !== null) applySgr(style, esc.sgr)
      i = esc.end
    } else if (code === 0x0a) {
      endLine()
      i++
    } else if (code === 0x0d && (i + 1 >= n || text.charCodeAt(i + 1) === 0x0a)) {
      i++
    } else if (code === 0x09) {
      var spaces = tabWidth - (column % tabWidth)
      append(new Array(spaces + 1).join(" "))
      i++
    } else if (isControl(code)) {
      append(replacement)
      i++
    } else {
      // Copy the longest stretch of ordinary characters at once.
      var j = i + 1
      while (j < n) {
        var c = text.charCodeAt(j)
        if (c === 0x1b || c === 0x0a || c === 0x0d || c === 0x09 || isControl(c)) break
        j++
      }
      append(text.slice(i, j))
      i = j
    }
  }
  if (lines.length < maxLines && (runs.length > 0 || pending !== "")) endLine()
  return lines
}

// Palette from `omarchy-theme-color --all` ("key<TAB>#rrggbb" lines): the
// sixteen terminal colors in ANSI order, as the theme templates resolve
// them (color0 = background, color5 = magenta/purple, color8 = muted, color15
// = bright_foreground, missing bright shades derived). Unknown entries are
// "", which the pane draws in its default text color.
function parsePalette(raw) {
  var palette = []
  for (var p = 0; p < 16; p++) palette.push("")
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^color([0-9]|1[0-5])\t(#[0-9A-Fa-f]{6})\s*$/)
    if (match) palette[Number(match[1])] = match[2].toLowerCase()
  }
  return palette
}

if (typeof module !== "undefined") {
  module.exports = { parse: parse, parsePalette: parsePalette, color256: color256 }
}
