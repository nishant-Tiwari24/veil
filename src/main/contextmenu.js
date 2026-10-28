// Right-click menu for web pages.
const { Menu, clipboard } = require('electron')

function attachContextMenu(wc, { openInNewTab, search }) {
  wc.on('context-menu', (e, p) => {
    const items = []
    const sep = () => { if (items.length && items.at(-1).type !== 'separator') items.push({ type: 'separator' }) }

    if (p.linkURL && /^https?:/.test(p.linkURL)) {
      items.push(
        { label: 'Open Link in New Tab', click: () => openInNewTab(p.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) },
      )
      sep()
    }
    if (p.mediaType === 'image' && /^https?:/.test(p.srcURL)) {
      items.push(
        { label: 'Open Image in New Tab', click: () => openInNewTab(p.srcURL) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(p.srcURL) },
      )
      sep()
    }
    if (p.isEditable) {
      items.push(
        { label: 'Undo', role: 'undo', enabled: p.editFlags.canUndo },
        { label: 'Redo', role: 'redo', enabled: p.editFlags.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: p.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste },
        { label: 'Select All', role: 'selectAll' },
      )
      sep()
    } else if (p.selectionText.trim()) {
      const text = p.selectionText.trim()
      items.push(
        { label: 'Copy', role: 'copy' },
        { label: `Search for "${text.length > 24 ? text.slice(0, 24) + '…' : text}"`, click: () => search(text) },
      )
      sep()
    }
    if (!p.linkURL && !p.isEditable && !p.selectionText.trim()) {
      const nav = wc.navigationHistory
      items.push(
        { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
        { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
        { label: 'Reload', click: () => wc.reload() },
      )
      sep()
      items.push({ label: 'Print…', click: () => wc.print() })
      sep()
    }
    items.push({ label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) })
    Menu.buildFromTemplate(items).popup()
  })
}

module.exports = { attachContextMenu }
