// Classifies a search result for the preview pane and builds the file:// URL
// the preview loads. Pure string work: no filesystem access and no
// subprocess, so it is cheap enough to run on every selection change.
//
// Only formats this Qt can decode are claimed. qt6-base reads png, jpeg, bmp,
// gif, ppm/pgm/pbm, xbm and xpm; qt6-imageformats adds tiff, webp, wbmp, icns
// and ico/cur; qt6-svg adds svg/svgz. Deliberately absent:
//   - avif, heic, jxl, jp2: no plugin without kimageformats.
//   - tga: Qt's reader handles only one uncompressed subtype and rejects
//     typical files.
//   - apng: decodes as a still PNG, which the "image" kind already covers.
// A claimed file that still fails to decode (corrupt, misnamed) falls back
// to the same placeholder as a non-image, so a wrong claim never breaks
// the pane.

var rasterTypes = {
  png: "PNG", jpg: "JPEG", jpeg: "JPEG", jpe: "JPEG", jfif: "JPEG",
  bmp: "BMP", dib: "BMP", ico: "ICO", cur: "CUR", tif: "TIFF", tiff: "TIFF",
  pbm: "PBM", pgm: "PGM", ppm: "PPM", xbm: "XBM", xpm: "XPM", wbmp: "WBMP",
  icns: "ICNS"
}
// Formats that may hold more than one frame. Each is shown as a still first
// and then handed to AnimatedImage.
var animatedTypes = { gif: "GIF", webp: "WebP" }
var vectorTypes = { svg: "SVG", svgz: "SVG" }

// Documents and videos are never decoded here. They get a preview only when
// the desktop already wrote a freedesktop thumbnail for them.
var documentTypes = { pdf: "PDF" }
var videoTypes = {
  mp4: "MP4", m4v: "M4V", mov: "MOV", webm: "WebM", mkv: "MKV", avi: "AVI",
  wmv: "WMV", flv: "FLV", mpg: "MPEG", mpeg: "MPEG", ogv: "OGV", "3gp": "3GP"
}

function isFolder(path) {
  return /\/$/.test(String(path || ""))
}

// The last path segment. fd marks folders with a trailing slash; it is not
// part of the name.
function baseName(path) {
  var p = String(path || "").replace(/\/+$/, "")
  var slash = p.lastIndexOf("/")
  return slash >= 0 ? p.slice(slash + 1) : p
}

// Lower-case extension of the base name, or "" for none. A leading dot marks
// a hidden file (".bashrc", ".png"), not an extension.
function extension(path) {
  if (isFolder(path)) return ""
  var name = baseName(path)
  var dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return ""
  return name.slice(dot + 1).toLowerCase()
}

function has(table, key) {
  return key !== "" && Object.prototype.hasOwnProperty.call(table, key)
}

// "folder" | "image" | "animated" | "vector" | "document" | "video" | "file"
function kind(path) {
  if (String(path || "") === "") return "file"
  if (isFolder(path)) return "folder"
  var ext = extension(path)
  if (has(rasterTypes, ext)) return "image"
  if (has(animatedTypes, ext)) return "animated"
  if (has(vectorTypes, ext)) return "vector"
  if (has(documentTypes, ext)) return "document"
  if (has(videoTypes, ext)) return "video"
  return "file"
}

// Kinds that are decoded in-process by an Image item.
function isDecodable(kindName) {
  return kindName === "image" || kindName === "animated" || kindName === "vector"
}

// Kinds that may have a freedesktop thumbnail worth showing.
function hasThumbnail(kindName) {
  return kindName === "document" || kindName === "video"
}

// Extensions that are never text. Selecting one skips the text preview's
// subprocess entirely. This only saves work: for every other "file" the
// subprocess itself decides whether the content is text (see TextPreview.js),
// so a missing entry here costs one quick refusal, never a wrong preview.
// A plain literal like the tables above: a top-level `new RegExp(...)` built
// from a joined list failed with "Type error" when this script was first
// evaluated inside a Repeater delegate (Qt 6.12).
var binaryTypes = {
  mp3: 1, flac: 1, ogg: 1, oga: 1, opus: 1, wav: 1, m4a: 1, aac: 1, wma: 1, mid: 1, midi: 1,
  zip: 1, tar: 1, gz: 1, tgz: 1, bz2: 1, xz: 1, zst: 1, "7z": 1, rar: 1, lz4: 1, lzma: 1,
  deb: 1, rpm: 1, iso: 1, img: 1, dmg: 1, jar: 1, apk: 1, whl: 1, cab: 1, msi: 1,
  doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1, odt: 1, ods: 1, odp: 1, epub: 1,
  exe: 1, dll: 1, so: 1, o: 1, a: 1, bin: 1, elf: 1, "class": 1, pyc: 1, wasm: 1,
  ttf: 1, otf: 1, woff: 1, woff2: 1, avif: 1, heic: 1, heif: 1, jxl: 1, jp2: 1, tga: 1,
  psd: 1, raw: 1, cr2: 1, nef: 1, xcf: 1, kra: 1, blend: 1, sqlite: 1, sqlite3: 1, db: 1,
  kdbx: 1, gpg: 1
}

// Files whose first screenful may be shown as text: anything the other kinds
// do not claim, except well-known binary formats.
function isTextCandidate(path) {
  return String(path || "") !== "" && kind(path) === "file" && !has(binaryTypes, extension(path))
}

// Short human label for the caption: "PNG image", "Folder", "PDF document".
function typeLabel(path) {
  var k = kind(path)
  var ext = extension(path)
  if (k === "folder") return "Folder"
  if (k === "image") return rasterTypes[ext] + " image"
  if (k === "animated") return animatedTypes[ext] + " image"
  if (k === "vector") return vectorTypes[ext] + " image"
  if (k === "document") return documentTypes[ext] + " document"
  if (k === "video") return videoTypes[ext] + " video"
  if (ext !== "" && ext.length <= 8 && /^[a-z0-9_+-]+$/.test(ext)) return ext.toUpperCase() + " file"
  return "File"
}

// Nerd Font (Font Awesome range) glyph for the placeholder. The same glyph
// family the bar's folder button uses.
function glyph(path) {
  var k = kind(path)
  if (k === "folder") return ""
  if (k === "image" || k === "animated" || k === "vector") return ""
  if (k === "document") return ""
  if (k === "video") return ""
  var ext = extension(path)
  if (/^(mp3|flac|ogg|oga|opus|wav|m4a|aac|wma)$/.test(ext)) return ""
  if (/^(zip|tar|gz|tgz|bz2|xz|zst|7z|rar|lz4|lzma)$/.test(ext)) return ""
  if (/^(txt|md|markdown|rst|org|log|csv|tsv)$/.test(ext)) return ""
  if (/^(js|ts|jsx|tsx|qml|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|lua|sh|bash|zsh|fish|json|toml|yaml|yml|xml|html|css|scss|conf|ini)$/.test(ext)) return ""
  return ""
}

// Plain-text-safe display name: control characters that a filename may
// contain are shown as the same symbols the result list uses.
function displayName(path) {
  return baseName(path).replace(/\n/g, "↵").replace(/\r/g, "↵").replace(/\t/g, "⇥")
}

// file:// URL with every path segment percent-encoded, so spaces, '#', '?',
// '%', newlines and non-ASCII names reach the decoder as literal bytes
// instead of being read as URL syntax. Relative paths are rejected rather
// than guessed at. Returns "" when the path cannot be encoded (for example a
// string with an unpaired surrogate).
function fileUrl(absolutePath) {
  var p = String(absolutePath || "")
  if (p.charAt(0) !== "/") return ""
  try {
    return "file://" + p.split("/").map(encodeURIComponent).join("/")
  } catch (e) {
    return ""
  }
}

// The file URI as GLib's g_filename_to_uri() spells it. The freedesktop
// thumbnail cache names each thumbnail after the MD5 of this exact string,
// and GLib leaves "$&+,:=@" unescaped in paths where encodeURIComponent does
// not.
function glibFileUri(absolutePath) {
  var url = fileUrl(absolutePath)
  if (url === "") return ""
  return url.replace(/%(24|26|2B|2C|3A|3D|40)/g, function(match, hex) {
    return String.fromCharCode(parseInt(hex, 16))
  })
}

// Thumbnail size folders under $XDG_CACHE_HOME/thumbnails, best first.
var thumbnailSizes = ["x-large", "large", "normal"]

// Thumbnail file names a path may have. GLib's spelling first: GNOME's
// thumbnailer wrote every thumbnail in the cache; the strictly encoded form
// covers thumbnailers that escape more. `md5` is injected (Qt.md5 in QML),
// so this module stays free of host APIs.
function thumbnailNames(absolutePath, md5) {
  if (typeof md5 !== "function") return []
  var names = []
  var glib = glibFileUri(absolutePath)
  var strict = fileUrl(absolutePath)
  if (glib !== "") names.push(md5(glib) + ".png")
  if (strict !== "" && strict !== glib) names.push(md5(strict) + ".png")
  return names
}

if (typeof module !== "undefined") {
  module.exports = {
    isFolder: isFolder, baseName: baseName, extension: extension, kind: kind,
    isDecodable: isDecodable, hasThumbnail: hasThumbnail, isTextCandidate: isTextCandidate, typeLabel: typeLabel,
    glyph: glyph, displayName: displayName, fileUrl: fileUrl, glibFileUri: glibFileUri,
    thumbnailSizes: thumbnailSizes, thumbnailNames: thumbnailNames
  }
}
