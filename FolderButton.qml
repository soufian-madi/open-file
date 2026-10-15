import QtQuick
import qs.Ui

// Folder button for the bar. Clicking it summons the open-file overlay.
//
// The bar host injects `bar` (a scoped bar facade for third-party widgets),
// `moduleName`, and `settings` — see the BarWidget base. The overlay lives in
// the same plugin, so the scoped shell facade can toggle it in-process.
BarWidget {
  id: root
  moduleName: "soufian.open-file"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function toggleOverlay() {
    var id = moduleName !== "" ? moduleName : "soufian.open-file"
    if (bar && bar.shell && typeof bar.shell.toggle === "function") {
      if (bar.shell.toggle(id, "{}")) return
    }
    if (bar) bar.run("omarchy-shell shell toggle " + id)
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\uf07b"
    tooltipText: "File search"
    onPressed: root.toggleOverlay()
  }
}
