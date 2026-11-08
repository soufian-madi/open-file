const test = require("node:test")
const assert = require("node:assert/strict")
const { fileURLToPath } = require("node:url")

const PreviewKind = require("../PreviewKind.js")

test("classifies folders by fd's trailing slash", () => {
  assert.equal(PreviewKind.kind("Pictures/"), "folder")
  assert.equal(PreviewKind.kind("/home/test/My Photos.png/"), "folder")
  assert.equal(PreviewKind.extension("/home/test/My Photos.png/"), "")
  assert.equal(PreviewKind.typeLabel("Pictures/"), "Folder")
})

test("classifies raster, animated and vector images case-insensitively", () => {
  for (const name of ["a.png", "a.jpg", "a.JPEG", "a.jpe", "a.jfif", "a.bmp", "a.dib", "a.ico",
    "a.cur", "a.tif", "a.TIFF", "a.pbm", "a.pgm", "a.ppm", "a.xbm", "a.xpm", "a.wbmp", "a.icns"]) {
    assert.equal(PreviewKind.kind("/p/" + name), "image", name)
  }
  for (const name of ["a.gif", "a.webp", "A.WEBP"]) {
    assert.equal(PreviewKind.kind("/p/" + name), "animated", name)
  }
  for (const name of ["a.svg", "a.svgz", "a.SVG"]) {
    assert.equal(PreviewKind.kind("/p/" + name), "vector", name)
  }
  for (const kind of ["image", "animated", "vector"]) assert.equal(PreviewKind.isDecodable(kind), true)
  for (const kind of ["folder", "document", "video", "file", ""]) assert.equal(PreviewKind.isDecodable(kind), false)
})

test("does not claim formats this Qt cannot decode", () => {
  for (const name of ["a.avif", "a.heic", "a.heif", "a.jxl", "a.jp2", "a.tga", "a.psd", "a.raw", "a.cr2"]) {
    assert.equal(PreviewKind.kind("/p/" + name), "file", name)
  }
})

test("classifies documents, videos and everything else for the placeholder", () => {
  assert.equal(PreviewKind.kind("/p/report.pdf"), "document")
  assert.equal(PreviewKind.kind("/p/clip.MP4"), "video")
  assert.equal(PreviewKind.kind("/p/clip.mkv"), "video")
  assert.equal(PreviewKind.kind("/p/notes.md"), "file")
  assert.equal(PreviewKind.kind("/p/archive.tar.gz"), "file")
  assert.equal(PreviewKind.kind(""), "file")
})

test("offers a text preview only for plain files that may be text", () => {
  for (const path of ["/p/notes.md", "/p/main.rs", "/p/Makefile", "/p/.bashrc", "/p/data.JSON",
    "/p/server.log", "/p/v1.2 final draft", "/p/a.thisisnotanextension"]) {
    assert.equal(PreviewKind.isTextCandidate(path), true, path)
  }
  for (const path of ["", "/p/Pictures/", "/p/a.png", "/p/a.svg", "/p/a.gif", "/p/a.pdf", "/p/a.mp4",
    "/p/a.mp3", "/p/a.tar.gz", "/p/a.ZIP", "/p/a.docx", "/p/a.so", "/p/a.ttf", "/p/a.sqlite", "/p/a.heic"]) {
    assert.equal(PreviewKind.isTextCandidate(path), false, path)
  }
})

test("treats a leading dot as a hidden name, not an extension", () => {
  assert.equal(PreviewKind.extension("/home/test/.png"), "")
  assert.equal(PreviewKind.kind("/home/test/.png"), "file")
  assert.equal(PreviewKind.extension("/home/test/.bashrc"), "")
  assert.equal(PreviewKind.extension("/home/test/.config/photo.png"), "png")
  assert.equal(PreviewKind.extension("/home/test/trailing."), "")
  assert.equal(PreviewKind.extension("/home/test/archive.tar.gz"), "gz")
})

test("labels entries for the caption", () => {
  assert.equal(PreviewKind.typeLabel("/p/a.jpg"), "JPEG image")
  assert.equal(PreviewKind.typeLabel("/p/a.webp"), "WebP image")
  assert.equal(PreviewKind.typeLabel("/p/a.svgz"), "SVG image")
  assert.equal(PreviewKind.typeLabel("/p/a.pdf"), "PDF document")
  assert.equal(PreviewKind.typeLabel("/p/a.mov"), "MOV video")
  assert.equal(PreviewKind.typeLabel("/p/notes.md"), "MD file")
  assert.equal(PreviewKind.typeLabel("/p/Makefile"), "File")
  // An odd or very long "extension" is not shouted back at the user.
  assert.equal(PreviewKind.typeLabel("/p/v1.2 final draft"), "File")
  assert.equal(PreviewKind.typeLabel("/p/a.thisisnotanextension"), "File")
})

test("names entries by their last segment with control characters made visible", () => {
  assert.equal(PreviewKind.baseName("/home/test/Pictures/"), "Pictures")
  assert.equal(PreviewKind.baseName("/home/test/a b.png"), "a b.png")
  assert.equal(PreviewKind.displayName("/p/line\nbreak\r\ttab.png"), "line↵break↵⇥tab.png")
})

test("returns a placeholder glyph for every kind", () => {
  assert.equal(PreviewKind.glyph("/p/Pictures/"), "\uf07b")
  for (const path of ["/p/a.png", "/p/a.pdf", "/p/a.mp4", "/p/a.mp3", "/p/a.zip", "/p/a.md", "/p/a.js", "/p/a.bin", "/p/x"]) {
    assert.match(PreviewKind.glyph(path), /^[\uf000-\uf8ff]$/, path)
  }
})

test("percent-encodes every path segment of the file URL", () => {
  const cases = [
    "/home/test/My Pictures/holiday photo.jpg",
    "/home/test/we#ird ?%20 name.png",
    "/home/test/100% done/file#1?.png",
    "/home/test/näme/日本語/émoji 🎉.png",
    "/home/test/line\nbreak/tab\there.png",
    "/home/test/semi;colon,comma&amp=eq+plus@at:colon$dollar.png",
    "/home/test/quote'\"back\\slash.png"
  ]
  for (const path of cases) {
    const url = PreviewKind.fileUrl(path)
    assert.ok(url.startsWith("file:///home/test/"), url)
    // Nothing URL-significant survives unescaped after the scheme.
    const rest = url.slice("file://".length)
    assert.doesNotMatch(rest, /[#?\s"\\]/, url)
    assert.doesNotMatch(rest, /%(?![0-9A-F]{2})/, url)
    assert.doesNotMatch(url, /[^\x21-\x7e]/, url)
    assert.equal(fileURLToPath(url), path, url)
  }
  assert.equal(PreviewKind.fileUrl("/home/test/a b#c.png"), "file:///home/test/a%20b%23c.png")
  assert.equal(PreviewKind.fileUrl("/home/test/%41.png"), "file:///home/test/%2541.png")
})

test("refuses relative and unencodable paths instead of guessing", () => {
  assert.equal(PreviewKind.fileUrl(""), "")
  assert.equal(PreviewKind.fileUrl("Pictures/a.png"), "")
  assert.equal(PreviewKind.fileUrl("/home/test/bad\ud800.png"), "")
})

const md5 = s => require("node:crypto").createHash("md5").update(s).digest("hex")

test("offers thumbnails only for documents and videos", () => {
  for (const kind of ["document", "video"]) assert.equal(PreviewKind.hasThumbnail(kind), true)
  for (const kind of ["image", "animated", "vector", "folder", "file", ""]) assert.equal(PreviewKind.hasThumbnail(kind), false)
})

test("spells file URIs the way GLib's g_filename_to_uri does", () => {
  // GLib keeps "$&+,:=@" literal in paths; everything else escapes like
  // encodeURIComponent. These URIs are taken from GNOME thumbnail metadata.
  assert.equal(PreviewKind.glibFileUri("/home/test/export+1-2026/a b.MOV"),
    "file:///home/test/export+1-2026/a%20b.MOV")
  assert.equal(PreviewKind.glibFileUri("/home/test/$&+,:=@;#?%.pdf"),
    "file:///home/test/$&+,:=@%3B%23%3F%25.pdf")
  assert.equal(PreviewKind.glibFileUri("/home/test/Übersicht ü.pdf"),
    "file:///home/test/%C3%9Cbersicht%20%C3%BC.pdf")
  assert.equal(PreviewKind.glibFileUri("relative.pdf"), "")
})

test("names thumbnails after the MD5 of the file URI, GLib spelling first", () => {
  // md5("file:///home/test/Downloads/Rechnung%202026+Q1.pdf"): the space is
  // escaped and the plus is not, as in GNOME's thumbnail cache.
  assert.deepEqual(
    PreviewKind.thumbnailNames("/home/test/Downloads/Rechnung 2026+Q1.pdf", md5),
    ["27be9e5f0fee512bb7f1dc6211097795.png", md5("file:///home/test/Downloads/Rechnung%202026%2BQ1.pdf") + ".png"])
  const names = PreviewKind.thumbnailNames("/home/test/a+b.mp4", md5)
  assert.deepEqual(names, [md5("file:///home/test/a+b.mp4") + ".png", md5("file:///home/test/a%2Bb.mp4") + ".png"])
  assert.deepEqual(PreviewKind.thumbnailNames("/home/test/a.pdf", null), [])
  assert.deepEqual(PreviewKind.thumbnailSizes, ["x-large", "large", "normal"])
})
