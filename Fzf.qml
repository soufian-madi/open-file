import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import qs.Commons
import qs.Ui
import "BoundedFile.js" as BoundedFile
import "ScopeState.js" as ScopeState
import "SearchCommand.js" as SearchCommand
import "OpenCommand.js" as OpenCommand
import "PreviewKind.js" as PreviewKind
import "TextPreview.js" as TextPreview
import "AnsiText.js" as AnsiText

Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null

  property bool opened: false
  property var dirs: []
  property int activeIndex: -1
  property int selectedIndex: 0
  property int searchGen: 0
  property bool searching: false
  property string searchError: ""
  property bool dirsLoaded: false
  property bool restoring: false
  property bool scopeLoaded: false
  property string lastScope: ""
  property string pendingScopeState: ""
  property bool stateDirReady: false

  readonly property int maxStateBytes: 8192
  readonly property int maxSearchOutputBytes: 262144
  readonly property int maxSearchErrorChars: 8192

  readonly property string stateHome: Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state"
  readonly property string stateDir: stateHome + "/soufian.open-file"
  readonly property string statePath: stateDir + "/state.json"
  // Freedesktop thumbnail cache; the spec ignores a relative XDG_CACHE_HOME.
  readonly property string cacheHome: /^\//.test(Quickshell.env("XDG_CACHE_HOME") || "")
    ? Quickshell.env("XDG_CACHE_HOME") : Quickshell.env("HOME") + "/.cache"

  // Shares the [menu] surface tokens — themes that style the menu also
  // style this overlay.
  property color background: Color.menu.background
  property color foreground: Color.menu.text
  property color border: Color.menu.border
  property var borderSpec: Border.surfaceSpec("menu", "border", border, Math.max(1, Style.space(2)))
  property color scrim: Color.menu.scrim
  property color selectedBackground: Color.menu.selectedBackground
  property color selectedText: Color.menu.selectedText
  readonly property int cornerRadius: Style.cornerRadius
  property string fontFamily: Style.font.menuFamily
  property int contentMargin: Style.spacing.panelPadding
  property int fieldHeight: Math.max(Style.space(34), Style.font.title + Style.spacing.controlPaddingY * 2)
  property int shortcutHeight: Math.max(Style.space(34), Style.font.caption + Style.spacing.controlPaddingY * 2)
  property int contentSpacing: Style.spacing.md
  // The card widens to hold a preview pane beside the results when the
  // screen has room for both; otherwise it keeps the single-column layout.
  readonly property int listCardWidth: Style.space(560)
  readonly property int previewCardWidth: Style.space(900)
  readonly property int previewMinWidth: Style.space(260)
  readonly property bool showPreview: panel.width - Style.gapsOut * 2 >= listCardWidth + previewMinWidth
  property int cardWidth: Math.min(showPreview ? previewCardWidth : listCardWidth, panel.width - Style.gapsOut * 2)
  property int cardHeight: Math.min(Style.space(500), panel.height - Style.gapsOut * 2)
  property int maxResults: 200
  // Absolute path shown in the preview pane; "" when nothing is selected.
  property string previewPath: ""
  readonly property int previewDelay: 80
  // Text preview of previewPath, rendered by bat in textPreviewProc: styled
  // lines (AnsiText.parse) for textPreviewPath, and whether that answer is
  // in. Done with no lines means "not text"; the pane keeps its placeholder.
  property string textPreviewPath: ""
  property var textPreviewLines: []
  property bool textPreviewDone: false
  property int textPreviewGen: 0
  // Kills a preview that has not answered by then; the script's own limits
  // (TextPreview.js) normally end it long before.
  readonly property int textPreviewTimeout: 2500
  readonly property int maxTextPreviewOutputBytes: 131072
  // The theme's 16 terminal colors in ANSI order, read on every open.
  property var terminalColors: []
  readonly property int maxPaletteBytes: 16384

  onSelectedIndexChanged: root.schedulePreview()
  onActiveIndexChanged: root.schedulePreview()
  onOpenedChanged: root.schedulePreview()
  onShowPreviewChanged: root.schedulePreview()

  Component.onCompleted: {
    root.loadHome()
    scopeReadProc.running = true
    stateDirProc.running = true
  }

  function resetSearch(clearActive) {
    if (completionProc.running) completionProc.running = false
    debounce.stop()
    root.searchGen++
    if (searchProc.running) searchProc.running = false
    if (clearActive) root.activeIndex = -1
    root.selectedIndex = 0
    root.searching = false
    root.searchError = ""
    resultModel.clear()
  }

  function open(payloadJson) {
    root.resetSearch(true)
    root.restoring = true
    for (var i = 0; i < fieldsRepeater.count; i++) {
      var field = fieldsRepeater.itemAt(i)
      if (!field) continue
      field.clearText()
      if (i === 0 && root.scopeLoaded && root.lastScope !== "") field.completeText(root.lastScope)
    }
    root.restoring = false
    root.opened = true
    root.focusField()
    // The theme may have changed since the last open.
    if (!paletteProc.running) paletteProc.running = true
  }

  function close() {
    root.opened = false
    root.resetSearch(true)
  }

  function dismiss() {
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide((root.manifest && root.manifest.id) || "soufian.open-file")
    else
      root.close()
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  function loadHome() {
    var home = Quickshell.env("HOME")
    root.dirs = [{ name: "Home", path: home }]
    root.dirsLoaded = true
    root.focusField()
  }

  function loadScope(raw) {
    root.lastScope = ScopeState.parse(raw)
    root.scopeLoaded = true
    // The state read can finish after the overlay was opened; restore into an
    // empty field so an early open still lands in the remembered scope.
    if (root.opened && root.lastScope !== "") {
      var field = fieldsRepeater.itemAt(0)
      if (field && field.text === "") {
        root.restoring = true
        field.completeText(root.lastScope)
        root.restoring = false
      }
    }
    root.focusField()
  }

  function focusField() {
    if (!root.opened || !root.dirsLoaded || !root.scopeLoaded) return
    Qt.callLater(function() {
      if (!root.opened) return
      var field = fieldsRepeater.itemAt(0)
      if (field) field.focusInput()
    })
  }

  function rememberScope(scope) {
    if (root.restoring || !root.scopeLoaded || scope === root.lastScope) return

    var serialized = ScopeState.serialize(scope)
    if (serialized === "") return
    root.lastScope = scope
    root.pendingScopeState = serialized

    if (root.stateDirReady) {
      root.flushScopeState()
    } else if (!stateDirProc.running) {
      stateDirProc.running = true
    }
  }

  function flushScopeState() {
    if (root.pendingScopeState === "" || stateWriteProc.running) return
    var plan = BoundedFile.writeCommand(root.statePath, root.pendingScopeState, root.maxStateBytes)
    root.pendingScopeState = ""
    // The state text is user-typed: it goes to the subprocess over stdin.
    stateWriteProc.pendingInput = plan.input
    stateWriteProc.command = plan.command
    stateWriteProc.running = true
  }

  function onQueryChanged(index, text) {
    if (completionProc.running) completionProc.running = false
    if (!root.restoring) root.rememberScope(SearchCommand.scope(text).prefix)
    if (text === "") {
      if (root.activeIndex === index) root.resetSearch(true)
      return
    }

    // Invalidate and remove the previous result set immediately. Waiting for
    // the debounce would leave stale rows actionable under the new query.
    root.searchGen++
    if (searchProc.running) searchProc.running = false
    root.activeIndex = index
    root.selectedIndex = 0
    root.searching = true
    root.searchError = ""
    resultModel.clear()
    debounce.restart()
  }

  function onFieldFocused(index) {
    // Focusing another field abandons the previous search: clear the text of
    // every other field so a stale query cannot resurrect its results.
    for (var i = 0; i < fieldsRepeater.count; i++) {
      if (i === index) continue
      var field = fieldsRepeater.itemAt(i)
      if (field && field.text !== "") field.clearText()
    }
    if (root.activeIndex !== index) {
      root.resetSearch(true)
    }
  }

  function runSearch() {
    if (root.activeIndex < 0 || root.activeIndex >= root.dirs.length) return
    var field = fieldsRepeater.itemAt(root.activeIndex)
    var query = field ? field.text : ""
    if (query === "") return
    // Set pendingGen only after exec(): stopping the previous process may
    // flush its collector synchronously, and that stale output must still
    // fail the generation check.
    var plan = SearchCommand.searchCommand(
      query, root.dirs[root.activeIndex].path, root.maxResults, root.maxSearchOutputBytes)
    searchProc.errorText = ""
    searchProc.pendingInput = plan.input
    searchProc.exec(plan.command)
    searchProc.pendingGen = root.searchGen
  }

  function applyResults(gen, raw) {
    if (gen !== root.searchGen) return
    root.searching = false
    root.searchError = ""
    resultModel.clear()
    var lines = String(raw || "").split("\0")
    for (var i = 0; i < lines.length && resultModel.count < root.maxResults; i++) {
      if (lines[i] === "") continue
      // Every command result is NUL-terminated. Ignore a trailing fragment if
      // a future command implementation ever reaches its byte cap mid-record.
      if (i === lines.length - 1 && raw && raw.charAt(raw.length - 1) !== "\0") continue
      resultModel.append({ path: lines[i] })
    }
    if (root.selectedIndex >= resultModel.count) root.selectedIndex = Math.max(0, resultModel.count - 1)
    Qt.callLater(function() {
      if (resultModel.count > 0) resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
    })
  }

  function finishSearch(gen, exitCode, stdoutText, stderrText) {
    if (gen !== root.searchGen) return
    if (exitCode === 0) {
      root.applyResults(gen, stdoutText)
      return
    }

    root.searching = false
    resultModel.clear()
    var detail = String(stderrText || "").trim()
    root.searchError = detail !== "" ? detail : "Search failed (exit " + exitCode + ")"
  }

  function select(delta, wrap) {
    if (resultModel.count === 0) return
    if (wrap) {
      root.selectedIndex = (root.selectedIndex + delta + resultModel.count) % resultModel.count
    } else {
      root.selectedIndex = Math.max(0, Math.min(resultModel.count - 1, root.selectedIndex + delta))
    }
    resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
  }

  function activateIndex(index) {
    if (root.activeIndex < 0 || root.activeIndex >= root.dirs.length) return
    if (index < 0 || index >= resultModel.count) return
    var fullPath = root.dirs[root.activeIndex].path + "/" + resultModel.get(index).path
    root.dismiss()
    Quickshell.execDetached(OpenCommand.command(fullPath))
  }

  // The preview follows the selection after a short pause, so holding a
  // navigation key does not decode every image it passes. It clears at once
  // when there is nothing to show.
  function schedulePreview() {
    if (!root.opened || !root.showPreview || root.activeIndex < 0 || resultModel.count === 0) {
      previewDebounce.stop()
      root.previewPath = ""
      root.refreshTextPreview()
      return
    }
    previewDebounce.restart()
  }

  function updatePreview() {
    var index = root.selectedIndex
    if (!root.opened || !root.showPreview || root.activeIndex < 0 || root.activeIndex >= root.dirs.length
        || index < 0 || index >= resultModel.count) {
      root.previewPath = ""
      root.refreshTextPreview()
      return
    }
    root.previewPath = root.dirs[root.activeIndex].path + "/" + resultModel.get(index).path
    root.refreshTextPreview()
  }

  // Starts the text preview for previewPath, at most one process at a time
  // and only from the debounced updatePreview (or to cancel). A selection
  // that lands back on the path already shown, as when typing refines the
  // query, reuses that answer.
  function refreshTextPreview() {
    var path = root.previewPath
    if (path !== "" && path === root.textPreviewPath) return
    // Invalidate first: the killed process reports its exit only after the
    // next one was requested (see textPreviewProc), so its output must
    // already fail the generation check.
    root.textPreviewGen++
    textPreviewWatchdog.stop()
    if (textPreviewProc.running) textPreviewProc.running = false
    root.textPreviewPath = path
    root.textPreviewLines = []
    root.textPreviewDone = false
    if (path === "" || !PreviewKind.isTextCandidate(path)) {
      root.textPreviewDone = true
      return
    }
    var plan = TextPreview.previewCommand(path, {
      maxLines: previewPane.textLineCapacity,
      maxOutputBytes: root.maxTextPreviewOutputBytes
    })
    // The path comes from a typed search: it goes to the subprocess over
    // stdin, like the query.
    textPreviewProc.pendingInput = plan.input
    textPreviewProc.exec(plan.command)
    textPreviewProc.pendingGen = root.textPreviewGen
    textPreviewWatchdog.restart()
  }

  function finishTextPreview(gen, exitCode, raw) {
    if (gen !== root.textPreviewGen) return
    textPreviewWatchdog.stop()
    root.textPreviewLines = exitCode === 0
      ? AnsiText.parse(raw, { maxLines: previewPane.textLineCapacity, maxColumns: previewPane.textColumnCapacity })
      : []
    root.textPreviewDone = true
  }

  function abandonTextPreview() {
    root.textPreviewGen++
    if (textPreviewProc.running) textPreviewProc.running = false
    root.textPreviewLines = []
    root.textPreviewDone = true
  }

  function completeDirectory() {
    var field = fieldsRepeater.itemAt(0)
    if (!field || completionProc.running) return
    var plan = SearchCommand.completionCommand(
      field.text, root.dirs[0].path, 1, root.maxSearchOutputBytes)
    completionProc.query = field.text
    completionProc.pendingInput = plan.input
    completionProc.exec(plan.command)
  }

  Process {
    id: completionProc
    property string query: ""
    property string pendingInput: ""
    stdinEnabled: true
    onStarted: {
      write(pendingInput)
      pendingInput = ""
    }
    stdout: StdioCollector { id: completionOutput; waitForEnd: true }
    onExited: function(exitCode) {
      var field = fieldsRepeater.itemAt(0)
      if (exitCode !== 0 || !root.opened || !field || field.text !== query) return
      var path = completionOutput.text.split("\0")[0]
      if (path !== "") field.completeText(path.replace(/\/$/, "") + "/")
    }
  }

  ListModel {
    id: resultModel
    onCountChanged: root.schedulePreview()
  }

  Timer {
    id: previewDebounce
    interval: root.previewDelay
    onTriggered: root.updatePreview()
  }

  Process {
    id: scopeReadProc
    command: BoundedFile.readCommand(root.statePath, root.maxStateBytes).command
    stdout: StdioCollector { id: scopeReadStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) root.loadScope(scopeReadStdout.text)
      else {
        if (exitCode === 65)
          console.warn("soufian.open-file: state file exceeds byte limit", root.statePath)
        root.loadScope("")
      }
    }
  }

  Process {
    id: stateDirProc
    command: BoundedFile.prepareDirectoryCommand(root.stateDir).command
    running: false
    onExited: function(exitCode) {
      if (exitCode === 0) {
        root.stateDirReady = true
        root.flushScopeState()
      } else {
        console.warn("soufian.open-file: could not create state directory", root.stateDir)
      }
    }
  }

  Process {
    id: stateWriteProc
    property string pendingInput: ""
    stdinEnabled: true
    running: false
    onStarted: {
      write(pendingInput)
      pendingInput = ""
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        console.warn("soufian.open-file: state write failed with exit", exitCode)
        // Let a later scope change retry the same state without immediately spinning.
        root.lastScope = ""
      }
      root.flushScopeState()
    }
  }

  Timer {
    id: debounce
    interval: 150
    onTriggered: root.runSearch()
  }

  Process {
    id: searchProc
    property int pendingGen: 0
    property string errorText: ""
    property string pendingInput: ""
    stdinEnabled: true
    onStarted: {
      write(pendingInput)
      pendingInput = ""
    }
    stdout: StdioCollector {
      id: searchStdout
      waitForEnd: true
    }
    stderr: SplitParser {
      // Empty markers emit arbitrary chunks instead of buffering whole lines.
      splitMarker: ""
      onRead: function(data) {
        var remaining = root.maxSearchErrorChars - searchProc.errorText.length
        if (remaining > 0)
          searchProc.errorText += String(data || "").slice(0, remaining)
      }
    }
    onExited: function(exitCode) {
      root.finishSearch(searchProc.pendingGen, exitCode, searchStdout.text, searchProc.errorText)
    }
  }

  // Renders the selected text file's first screenful (TextPreview.js). When
  // a process is stopped and exec() is called at once, Quickshell starts the
  // new one only after the old one exited, and that old exit is reported
  // after pendingGen already holds the new generation. The generation is
  // therefore stamped when a process actually starts: an exit always carries
  // the generation of the process that produced it.
  Process {
    id: textPreviewProc
    property int pendingGen: 0
    property int startedGen: 0
    property string pendingInput: ""
    stdinEnabled: true
    onStarted: {
      startedGen = pendingGen
      write(pendingInput)
      pendingInput = ""
    }
    stdout: StdioCollector {
      id: textPreviewStdout
      waitForEnd: true
    }
    onExited: function(exitCode) {
      root.finishTextPreview(textPreviewProc.startedGen, exitCode, textPreviewStdout.text)
    }
  }

  Timer {
    id: textPreviewWatchdog
    interval: root.textPreviewTimeout
    onTriggered: root.abandonTextPreview()
  }

  Process {
    id: paletteProc
    command: TextPreview.paletteCommand(root.maxPaletteBytes).command
    stdout: StdioCollector { id: paletteStdout; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) root.terminalColors = AnsiText.parsePalette(paletteStdout.text)
    }
  }

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "soufian-open-file"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      width: root.cardWidth
      height: root.cardHeight
      radius: root.cornerRadius
      anchors.centerIn: parent
      color: root.background
      borderSpec: root.borderSpec
      padding: root.contentMargin

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset

        Column {
          id: fieldsColumn
          anchors.top: parent.top
          anchors.left: parent.left
          anchors.right: parent.right
          spacing: Style.space(4)

          Repeater {
            id: fieldsRepeater
            model: root.dirs

            delegate: Rectangle {
              id: fieldRow

              required property int index
              required property var modelData

              property alias text: input.text

              function clearText() { input.text = "" }
              function focusInput() { input.forceActiveFocus() }
              function completeText(value) {
                input.text = value
                input.cursorPosition = value.length
                input.forceActiveFocus()
              }

              visible: root.activeIndex === -1 || root.activeIndex === index
              width: parent.width
              height: visible ? root.fieldHeight : 0
              radius: root.cornerRadius
              color: input.activeFocus
                ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                : "transparent"

              Text {
                id: dirLabel
                anchors.left: parent.left
                anchors.leftMargin: Style.spacing.controlPaddingX
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(110)
                text: fieldRow.modelData.name
                textFormat: Text.PlainText
                color: root.foreground
                opacity: input.activeFocus || input.text !== "" ? 1 : 0.58
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                elide: Text.ElideRight
              }

              TextInput {
                id: input
                anchors.left: dirLabel.right
                anchors.leftMargin: Style.space(8)
                anchors.right: parent.right
                anchors.rightMargin: Style.spacing.controlPaddingX
                anchors.verticalCenter: parent.verticalCenter
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                clip: true
                cursorVisible: activeFocus

                onTextChanged: root.onQueryChanged(fieldRow.index, text)
                onActiveFocusChanged: if (activeFocus) root.onFieldFocused(fieldRow.index)

                Keys.onPressed: function(event) {
                  var control = (event.modifiers & Qt.ControlModifier) !== 0
                  if (event.key === Qt.Key_Escape) {
                    if (input.text !== "") input.text = ""
                    else root.dismiss()
                    event.accepted = true
                  } else if (event.key === Qt.Key_Up || (control && event.key === Qt.Key_K)) {
                    root.select(-1, true)
                    event.accepted = true
                  } else if (event.key === Qt.Key_Down || (control && event.key === Qt.Key_J)) {
                    root.select(1, true)
                    event.accepted = true
                  } else if (event.key === Qt.Key_PageUp || (control && event.key === Qt.Key_U)) {
                    root.select(-10, false)
                    event.accepted = true
                  } else if (event.key === Qt.Key_PageDown || (control && event.key === Qt.Key_D)) {
                    root.select(10, false)
                    event.accepted = true
                  } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                    root.activateIndex(root.selectedIndex)
                    event.accepted = true
                   } else if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
                    root.completeDirectory()
                    event.accepted = true
                  }
                }

                Text {
                  anchors.fill: parent
                  visible: input.text === ""
                  text: "Search " + fieldRow.modelData.name + "…"
                  textFormat: Text.PlainText
                  color: root.foreground
                  opacity: 0.38
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                  verticalAlignment: Text.AlignVCenter
                  elide: Text.ElideRight
                }
              }
            }
          }
        }

        Item {
          anchors.top: fieldsColumn.bottom
          anchors.topMargin: root.contentSpacing
          anchors.left: parent.left
          anchors.right: previewPane.visible ? previewPane.left : parent.right
          anchors.rightMargin: previewPane.visible ? Style.spacing.xxl : 0
          anchors.bottom: shortcuts.top
          anchors.bottomMargin: root.contentSpacing
          visible: root.activeIndex !== -1

          ListView {
            id: resultList
            anchors.fill: parent
            model: resultModel
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            delegate: Rectangle {
              required property int index
              required property string path

              readonly property bool hasCursor: index === root.selectedIndex

              width: resultList.width
              height: Math.max(Style.space(28), Style.font.body + Style.spacing.controlPaddingY * 2)
              radius: root.cornerRadius
              color: hasCursor ? root.selectedBackground : "transparent"

              Text {
                anchors.left: parent.left
                anchors.leftMargin: Style.spacing.controlPaddingX
                anchors.right: parent.right
                anchors.rightMargin: Style.spacing.controlPaddingX
                anchors.verticalCenter: parent.verticalCenter
                text: parent.path.replace(/\n/g, "↵").replace(/\r/g, "↵").replace(/\t/g, "⇥")
                textFormat: Text.PlainText
                color: parent.hasCursor ? root.selectedText : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideMiddle
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onContainsMouseChanged: if (containsMouse) root.selectedIndex = index
                onClicked: {
                  root.selectedIndex = index
                  root.activateIndex(index)
                }
              }
            }
          }

          Text {
            anchors.centerIn: parent
            width: parent.width - Style.spacing.controlPaddingX * 2
            visible: root.activeIndex !== -1 && resultModel.count === 0
            text: root.searching ? "Searching…" : (root.searchError || "No matches")
            textFormat: Text.PlainText
            color: root.foreground
            opacity: 0.7
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }
        }

        PreviewPane {
          id: previewPane
          anchors.top: fieldsColumn.bottom
          anchors.topMargin: root.contentSpacing
          anchors.right: parent.right
          anchors.bottom: shortcuts.top
          anchors.bottomMargin: root.contentSpacing
          width: Math.max(root.previewMinWidth, Math.round(parent.width * 0.4))
          visible: root.showPreview && root.activeIndex !== -1
          path: root.previewPath
          textPath: root.textPreviewPath
          textLines: root.textPreviewLines
          textDone: root.textPreviewDone
          terminalColors: root.terminalColors
          foreground: root.foreground
          fontFamily: root.fontFamily
          cornerRadius: root.cornerRadius
          thumbnailRoot: root.cacheHome + "/thumbnails"
        }

        Item {
          id: shortcuts
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          height: root.shortcutHeight

          Rectangle {
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            height: Math.max(1, Style.space(1))
            color: root.border
            opacity: 0.6
          }

          Row {
            anchors.centerIn: parent
            spacing: Style.space(12)

            Repeater {
              model: root.activeIndex === -1
                ? [
                    { keys: "Tab", action: "Complete folder" },
                    { keys: "Esc", action: "Close" }
                  ]
                : [
                    { keys: "↑ ↓", action: "Navigate" },
                    { keys: "PgUp PgDn", action: "Page" },
                    { keys: "Enter", action: "Open" },
                    { keys: "Tab", action: "Complete folder" },
                    { keys: "Esc", action: "Clear" }
                  ]

              delegate: Row {
                id: shortcut

                required property var modelData

                height: keycap.height
                spacing: Style.space(4)

                Rectangle {
                  id: keycap
                  width: keyText.implicitWidth + Style.space(8)
                  height: Math.max(Style.space(20), Style.font.caption + Style.space(6))
                  radius: Math.min(root.cornerRadius, height / 2)
                  color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)

                  Text {
                    id: keyText
                    anchors.centerIn: parent
                    text: shortcut.modelData.keys
                    textFormat: Text.PlainText
                    color: root.foreground
                    opacity: 0.85
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }

                Text {
                  height: keycap.height
                  text: shortcut.modelData.action
                  textFormat: Text.PlainText
                  color: root.foreground
                  opacity: 0.58
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  verticalAlignment: Text.AlignVCenter
                }
              }
            }
          }
        }
      }
    }
  }
}
