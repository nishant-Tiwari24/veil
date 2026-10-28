// Bookmarks — the only thing Veil writes to disk, and only when the user asks.
// Panic deletes the file.
const fs = require('fs')
const path = require('path')

class Bookmarks {
  constructor(dir) {
    this.file = path.join(dir, 'bookmarks.json')
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { this.items = [] }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2), { mode: 0o600 })
  }

  list() { return this.items }

  has(url) { return this.items.some(b => b.url === url) }

  toggle(url, title) {
    if (!/^https?:/.test(url || '')) return false
    if (this.has(url)) this.items = this.items.filter(b => b.url !== url)
    else this.items.unshift({ url, title: title || url, added: Date.now() })
    this._save()
    return this.has(url)
  }

  remove(url) {
    this.items = this.items.filter(b => b.url !== url)
    this._save()
  }

  wipe() {
    this.items = []
    fs.rmSync(this.file, { force: true })
  }
}

module.exports = { Bookmarks }
