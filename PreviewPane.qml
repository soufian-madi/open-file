import QtQuick
import Qt.labs.folderlistmodel
import Quickshell.Widgets
import qs.Commons
import "PreviewKind.js" as PreviewKind

// Read-only preview of the selected result. Purely visual: nothing in here
// accepts focus or input, so every key and click keeps going to the search
// field and the result list exactly as before.
//
// Images are decoded off the GUI thread (asynchronous), uncached, and never
// at more than the pane's size:
//
//   - Raster images use Qt's default Stretch fill with a sourceSize bound.
//     With PreserveAspectFit, Qt scales the *decode* to cover sourceSize: a
//     16x16 icon decodes blurred at the full pane size and an 8000x400
//     panorama at 6000x300. Without it, sourceSize is a bound Qt only ever
//     shrinks to, so the bitmap is never larger than the pane or the file.
//     The bound is square because Qt applies it before EXIF rotation; a
//     square fits the same either way round. This item then places the
//     bitmap: shrunk to fit, or enlarged by a whole factor (at most
//     maxUpscale) without smoothing, so pixel art stays crisp.
//   - Animated formats show that still first. Only when the still reports
//     more than one frame, and the original is within maxAnimatedPixels,
//     does an AnimatedImage take over, decoding at exactly the still's size
//     (it stretches to sourceSize, so it needs the right ratio up front).
//     AnimatedImage decodes every frame on the GUI thread at the file's full
//     resolution, about 6 ms per frame at 480x270 and 21 ms at 1280x720,
//     and a large still WebP through it blocks for over 100 ms. Stills
//     therefore never reach it, and large animations stay on their first
//     frame, so a preview can never make typing or navigation stutter.
//   - SVG renders at exactly sourceSize, so a 32px probe learns its aspect
//     ratio first. Rendering it straight into the pane's box would cover
//     the box: a 3000x30 SVG would render at 30000x300.
//
// PDFs and videos are never decoded. If the desktop already wrote a
// freedesktop thumbnail for one (GNOME's thumbnailer names them after the MD5
// of the file URI), that PNG is shown like any raster image. The thumbnail
// folders are listed in-process, once and only after such a file is first
// selected, so a missing thumbnail costs a lookup instead of failed loads.
// Thumbnails are never generated here.
//
// Text files show their first screenful the way Omarchy's `ff` previews them
// (bat --style=numbers with the ansi theme): a dim line-number gutter, then
// the lines, colored with the theme's terminal palette. The overlay runs bat
// and hands over styled runs (AnsiText.js); this pane draws each run with a
// plain-text item and never runs anything itself. Lines are clipped, never
// wrapped, and only as many lines and columns as fit are kept.
//
// Anything else, or anything that fails to decode or is not text, shows a
// calm placeholder: a file-type glyph plus the name and type.
Item {
  id: pane

  // Absolute path of the entry to preview; "" shows an empty pane.
  property string path: ""
  // $XDG_CACHE_HOME/thumbnails; "" disables thumbnail lookup.
  property string thumbnailRoot: ""
  property color foreground: Color.menu.text
  property string fontFamily: Style.font.menuFamily
  property int cornerRadius: Style.cornerRadius
  // Largest whole-number enlargement for small raster images.
  property int maxUpscale: 8
  // Largest animation, in source pixels, that is played rather than shown
  // as its first frame. 0.5 MP keeps each GUI-thread frame decode near 12 ms.
  property int maxAnimatedPixels: 500000

  // Text preview, supplied by the overlay: styled lines (AnsiText.parse) for
  // textPath, and whether that answer is in. No lines means "not text".
  property string textPath: ""
  property var textLines: []
  property bool textDone: false
  // The theme's 16 terminal colors in ANSI order; "" or missing entries use
  // the text color.
  property var terminalColors: []

  readonly property bool textKind: path !== "" && PreviewKind.isTextCandidate(path)
  readonly property bool textAnswered: textKind && textPath === path && textDone
  readonly property bool textShown: textAnswered && textLines.length > 0
  // Waiting for the text: show nothing yet rather than flash the placeholder.
  readonly property bool textPending: textKind && !textAnswered

  // Code is set like a terminal: the shared monospace family at a size that
  // leaves room for a useful line length in the narrow pane.
  readonly property int codeFontSize: Style.font.bodySmall
  readonly property int lineHeight: Math.max(1, Math.ceil(codeMetrics.height))
  readonly property real columnWidth: {
    // advanceWidth() is a call: read the font so a font change re-evaluates.
    var font = codeMetrics.font
    return Math.max(1, codeMetrics.advanceWidth("0"))
  }
  // How much text fits; the overlay asks for no more than this.
  readonly property int textLineCapacity: Math.max(1, Math.floor(stage.height / lineHeight))
  readonly property int textColumnCapacity: Math.max(1, Math.ceil(stage.width / columnWidth))
  readonly property int gutterDigits: Math.max(2, String(textLines.length).length)
  readonly property real gutterWidth: Math.ceil(gutterDigits * columnWidth)

  function runColor(color) {
    if (typeof color === "string" && color !== "") return color
    if (typeof color === "number" && color >= 0 && color < terminalColors.length && terminalColors[color] !== "")
      return terminalColors[color]
    return foreground
  }

  FontMetrics {
    id: codeMetrics
    font.family: Style.font.family
    font.pixelSize: pane.codeFontSize
  }

  readonly property string kind: path === "" ? "" : PreviewKind.kind(path)
  readonly property bool decodable: PreviewKind.isDecodable(kind)
  readonly property bool vector: kind === "vector"
  readonly property bool thumbnailKind: thumbnailRoot !== "" && PreviewKind.hasThumbnail(kind)
  // Waiting for the thumbnail folders to be listed: show nothing yet rather
  // than flash the placeholder.
  readonly property bool thumbnailPending: thumbnailKind
    && !(thumbnailIndex.item !== null && thumbnailIndex.item.ready)
  // Latches on the first PDF or video, so the folders are listed only once
  // something can use them.
  property bool thumbnailsWanted: false
  onThumbnailKindChanged: if (thumbnailKind) thumbnailsWanted = true

  readonly property string thumbnailUrl: {
    var index = thumbnailIndex.item
    if (!thumbnailKind || index === null || !index.ready) return ""
    // Re-evaluate when a thumbnail appears or disappears.
    var revision = index.revision
    var names = PreviewKind.thumbnailNames(path, Qt.md5)
    for (var s = 0; s < index.lists.length; s++) {
      for (var n = 0; n < names.length; n++) {
        var file = PreviewKind.fileUrl(thumbnailRoot + "/" + PreviewKind.thumbnailSizes[s] + "/" + names[n])
        if (index.lists[s].indexOf(file) >= 0) return file
      }
    }
    return ""
  }

  readonly property string url: decodable ? PreviewKind.fileUrl(path) : thumbnailUrl
  readonly property real dpr: Screen.devicePixelRatio > 0 ? Screen.devicePixelRatio : 1

  // Square decode bound in physical pixels.
  readonly property int bound: Math.ceil(Math.max(stage.width, stage.height) * dpr)

  readonly property bool stillOk: still.status === Image.Ready
    && still.implicitWidth > 0 && still.implicitHeight > 0
  readonly property bool failed: path !== "" && !thumbnailPending && !textPending && !textShown
    && (!(decodable || thumbnailKind) || url === ""
    || still.status === Image.Error || probe.status === Image.Error
    || (still.status === Image.Ready && !stillOk))
  readonly property bool animating: animLoader.item !== null
    && animLoader.item.status === Image.Ready && animLoader.item.frameCount > 1
  readonly property bool multiFrame: kind === "animated" && stillOk && still.frameCount > 1

  // A raster decode is the file's real size only if the bound did not shrink
  // it. A shrunk decode has its long side exactly on the bound, so a long
  // side below the bound proves the dimensions are the original ones.
  readonly property bool exactSize: stillOk && decodable && !vector
    && Math.max(still.implicitWidth, still.implicitHeight) < bound

  // An animation larger than the pane needs its real size to decide whether
  // it may play. sizeProbe decodes its first frame once, off the GUI thread,
  // and is released as soon as the size is read.
  property string measuredUrl: ""
  property int measuredWidth: 0
  property int measuredHeight: 0
  readonly property bool measured: measuredUrl !== "" && measuredUrl === url
  readonly property int originalWidth: exactSize ? still.implicitWidth : measured ? measuredWidth : 0
  readonly property int originalHeight: exactSize ? still.implicitHeight : measured ? measuredHeight : 0
  // One binding over values that are all in place before `measured` flips.
  // Deriving it from originalWidth * originalHeight would briefly see the new
  // width with the old zero height, pass the budget, and start a full-size
  // GUI-thread decode for an instant.
  readonly property int originalPixels: exactSize ? still.implicitWidth * still.implicitHeight
    : measured ? measuredWidth * measuredHeight : 0
  readonly property bool mayAnimate: multiFrame && originalPixels > 0
    && originalPixels <= maxAnimatedPixels

  // Placed size of the bitmap in logical pixels.
  readonly property real nativeWidth: stillOk ? still.implicitWidth / dpr : 0
  readonly property real nativeHeight: stillOk ? still.implicitHeight / dpr : 0
  readonly property real fitScale: stillOk
    ? Math.min(stage.width / nativeWidth, stage.height / nativeHeight) : 0
  // Small images grow by a whole factor, at most maxUpscale and never past
  // half the stage, so an icon or sprite reads clearly without a photo
  // turning into a wall of blocks.
  readonly property real placedScale: vector || fitScale < 1
    ? fitScale
    : Math.max(1, Math.min(maxUpscale, Math.floor(fitScale / 2)))

  Loader {
    id: thumbnailIndex
    active: pane.thumbnailsWanted
    sourceComponent: Item {
      // In thumbnailSizes order: x-large, large, normal.
      readonly property var lists: [xLarge, large, normal]
      readonly property bool ready: xLarge.status === FolderListModel.Ready
        && large.status === FolderListModel.Ready && normal.status === FolderListModel.Ready
      readonly property int revision: xLarge.count + large.count + normal.count

      FolderListModel {
        id: xLarge
        folder: PreviewKind.fileUrl(pane.thumbnailRoot + "/x-large")
        nameFilters: ["*.png"]
        showDirs: false
        showDotAndDotDot: false
        sortField: FolderListModel.Unsorted
      }
      FolderListModel {
        id: large
        folder: PreviewKind.fileUrl(pane.thumbnailRoot + "/large")
        nameFilters: ["*.png"]
        showDirs: false
        showDotAndDotDot: false
        sortField: FolderListModel.Unsorted
      }
      FolderListModel {
        id: normal
        folder: PreviewKind.fileUrl(pane.thumbnailRoot + "/normal")
        nameFilters: ["*.png"]
        showDirs: false
        showDotAndDotDot: false
        sortField: FolderListModel.Unsorted
      }
    }
  }

  Rectangle {
    anchors.fill: parent
    radius: pane.cornerRadius
    color: Qt.rgba(pane.foreground.r, pane.foreground.g, pane.foreground.b, Style.normalFillAlpha)
  }

  Item {
    id: stage
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: caption.top
    anchors.margins: Style.spacing.xxl
    anchors.bottomMargin: Style.spacing.lg

    // SVG aspect probe: covers a 32px square, so its bitmap is at most a few
    // kilobytes for ordinary art and stays small even for extreme ratios.
    Image {
      id: probe
      visible: false
      asynchronous: true
      cache: false
      fillMode: Image.PreserveAspectFit
      sourceSize.width: 32
      sourceSize.height: 32
      source: pane.vector && stage.width > 0 && stage.height > 0 ? pane.url : ""
    }

    Image {
      id: sizeProbe
      visible: false
      asynchronous: true
      cache: false
      autoTransform: true
      source: pane.multiFrame && !pane.exactSize && !pane.measured ? pane.url : ""
      onStatusChanged: {
        if (status !== Image.Ready || String(source) !== pane.url) return
        pane.measuredWidth = implicitWidth
        pane.measuredHeight = implicitHeight
        pane.measuredUrl = pane.url
      }
    }

    readonly property bool probeOk: probe.status === Image.Ready
      && probe.implicitWidth > 0 && probe.implicitHeight > 0
    readonly property real vectorAspect: probeOk ? probe.implicitWidth / probe.implicitHeight : 0
    readonly property real vectorWidth: vectorAspect <= 0 ? 0
      : Math.min(width, height * vectorAspect)
    readonly property real vectorHeight: vectorAspect <= 0 ? 0
      : Math.min(height, width / vectorAspect)

    ClippingRectangle {
      id: frame

      readonly property bool shown: pane.stillOk && !pane.failed

      width: Math.round(pane.nativeWidth * pane.placedScale)
      height: Math.round(pane.nativeHeight * pane.placedScale)
      anchors.centerIn: parent
      // Enlarged pixel art keeps square corners; rounding would shave
      // whole pixels off it.
      radius: pane.placedScale > 1 && !pane.vector ? 0 : Math.min(pane.cornerRadius, Math.min(width, height) / 8)
      color: "transparent"
      opacity: 0

      onShownChanged: {
        fade.stop()
        if (shown) fade.start()
        else opacity = 0
      }

      NumberAnimation {
        id: fade
        target: frame
        property: "opacity"
        from: 0
        to: 1
        duration: Style.duration(140)
        easing.type: Easing.OutCubic
      }

      Image {
        id: still
        anchors.fill: parent
        visible: !pane.animating
        asynchronous: true
        cache: false
        autoTransform: true
        // Raster: shrink-only bound (Stretch). SVG: render at the fitted box.
        fillMode: pane.vector ? Image.PreserveAspectFit : Image.Stretch
        sourceSize.width: pane.vector ? Math.ceil(stage.vectorWidth * pane.dpr) : pane.bound
        sourceSize.height: pane.vector ? Math.ceil(stage.vectorHeight * pane.dpr) : pane.bound
        source: pane.bound <= 0 ? ""
          : pane.vector ? (stage.vectorWidth > 0 ? pane.url : "")
          : pane.url
        // Whole-number enlargement stays sharp; shrinking is smoothed.
        smooth: pane.placedScale < 1 || pane.vector
      }

      Loader {
        id: animLoader
        anchors.fill: parent
        active: pane.mayAnimate
        sourceComponent: AnimatedImage {
          asynchronous: true
          cache: false
          // AnimatedImage stretches to sourceSize: hand it the still's exact
          // decoded size so frames come out at the right ratio, no larger.
          sourceSize.width: still.implicitWidth
          sourceSize.height: still.implicitHeight
          source: pane.url
          playing: true
          smooth: pane.placedScale < 1
        }
      }
    }

    // The text preview: one row per line, a right-aligned dim number, then
    // one plain-text item per styled run. Clipped at the stage, never wrapped.
    //
    // A screenful is a couple of hundred Text items. Created in one go they
    // held the GUI thread for 27-48 ms per selection (measured headless), so
    // every new set of lines builds a fresh block asynchronously: the Loader
    // incubates it, the Repeaters inside inherit that (AsynchronousIfNested),
    // and the work is spread over frames instead of stalling typing and
    // navigation. The block appears, with a short fade, once it is complete.
    Loader {
      id: textLoader
      anchors.fill: parent
      active: pane.textShown
      asynchronous: true

      sourceComponent: Item {
        id: textBlock
        clip: true

        NumberAnimation on opacity {
          from: 0
          to: 1
          duration: Style.duration(140)
          easing.type: Easing.OutCubic
        }

        Column {
          Repeater {
            model: pane.textLines

            Item {
              id: codeLine

              required property int index
              required property var modelData

              width: textBlock.width
              height: pane.lineHeight

              Text {
                width: pane.gutterWidth
                height: pane.lineHeight
                text: String(codeLine.index + 1)
                textFormat: Text.PlainText
                color: pane.foreground
                opacity: 0.38
                font.family: Style.font.family
                font.pixelSize: pane.codeFontSize
                horizontalAlignment: Text.AlignRight
                verticalAlignment: Text.AlignVCenter
              }

              Row {
                x: pane.gutterWidth + Style.spacing.lg
                height: pane.lineHeight

                Repeater {
                  model: codeLine.modelData

                  Text {
                    required property var modelData

                    height: pane.lineHeight
                    text: modelData.text
                    textFormat: Text.PlainText
                    color: pane.runColor(modelData.color)
                    opacity: modelData.dim ? 0.58 : 1
                    font.family: Style.font.family
                    font.pixelSize: pane.codeFontSize
                    font.bold: modelData.bold
                    font.italic: modelData.italic
                    font.underline: modelData.underline
                    verticalAlignment: Text.AlignVCenter
                  }
                }
              }
            }
          }
        }
      }
    }

    Text {
      anchors.centerIn: parent
      visible: pane.failed
      text: PreviewKind.glyph(pane.path)
      textFormat: Text.PlainText
      color: pane.foreground
      opacity: 0.3
      font.family: Style.font.family
      font.pixelSize: Style.font.display * 2
    }
  }

  Column {
    id: caption
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.leftMargin: Style.spacing.xxl
    anchors.rightMargin: Style.spacing.xxl
    anchors.bottomMargin: Style.spacing.xxl
    spacing: Style.spacing.xxs
    visible: pane.path !== ""

    Text {
      width: parent.width
      text: PreviewKind.displayName(pane.path)
      textFormat: Text.PlainText
      color: pane.foreground
      font.family: pane.fontFamily
      font.pixelSize: Style.font.body
      horizontalAlignment: Text.AlignHCenter
      elide: Text.ElideMiddle
    }

    Text {
      width: parent.width
      text: pane.path === "" ? ""
        : PreviewKind.typeLabel(pane.path)
          + (pane.originalWidth > 0 ? "  ·  " + pane.originalWidth + " × " + pane.originalHeight : "")
      textFormat: Text.PlainText
      color: pane.foreground
      opacity: 0.58
      font.family: pane.fontFamily
      font.pixelSize: Style.font.caption
      horizontalAlignment: Text.AlignHCenter
      elide: Text.ElideRight
    }
  }
}
