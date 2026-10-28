const $ = id => document.getElementById(id)
const api = window.veilUI
let state = { tabs: [], activeId: null, tor: {}, level: 'standard', panelOpen: false }
let editingAddress = false
let circuitTimer = null
let dragId = null
let lastSuggest = ''
const SEARCH_HOST = 'duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion'

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function icon(name, cls) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  if (cls) svg.setAttribute('class', cls)
  const use = document.createElementNS(ns, 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}

function siteIcon(site) {
  if (!site || site === 'veil') return 'veil'
  return site.endsWith('.onion') ? 'onion' : 'lock'
}

// Show search terms instead of the long onion search URL, like modern Chrome does.
function displayUrl(url) {
  if (!url || url.startsWith('veil://hub')) return ''
  try {
    const u = new URL(url)
    if (u.hostname === SEARCH_HOST && u.searchParams.get('q')) return u.searchParams.get('q')
  } catch {}
  return url
}

// Tab elements are kept and updated in place, never rebuilt: a click is
// mousedown + mouseup on the same element, so replacing the × between the two
// (every state update did) swallowed the click.
const tabEls = new Map() // id -> { n, iconSlot, title, key }

function createTabEl(id) {
  const n = el('div', 'tab')
  const iconSlot = el('span')
  iconSlot.style.display = 'contents'
  const title = el('span', 'title')
  const close = el('button', 'close', '×')
  close.title = 'Close tab'
  close.onmousedown = e => e.stopPropagation() // don't activate the tab we're closing
  close.onclick = e => { e.stopPropagation(); api.invoke('closeTab', id) }
  n.append(iconSlot, title, close)
  n.onmousedown = e => { if (e.button === 0 && id !== state.activeId) api.invoke('activate', id) }
  n.onauxclick = e => { if (e.button === 1) api.invoke('closeTab', id) }
  n.oncontextmenu = e => { e.preventDefault(); api.invoke('tabMenu', id) }
  // drag to reorder
  n.draggable = true
  n.ondragstart = e => { dragId = id; n.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move' }
  n.ondragend = () => { dragId = null; n.classList.remove('dragging') }
  n.ondragover = e => { if (dragId != null) e.preventDefault() }
  n.ondrop = e => {
    e.preventDefault()
    if (dragId == null || dragId === id) return
    api.invoke('moveTab', dragId, state.tabs.findIndex(x => x.id === id))
  }
  return { n, iconSlot, title, key: null }
}

function renderTabs() {
  const container = $('tabs')
  const live = new Set(state.tabs.map(t => t.id))
  for (const [id, t] of tabEls) if (!live.has(id)) { t.n.remove(); tabEls.delete(id) }

  state.tabs.forEach((t, i) => {
    let te = tabEls.get(t.id)
    if (!te) { te = createTabEl(t.id); tabEls.set(t.id, te) }
    te.n.classList.toggle('active', t.id === state.activeId)
    te.n.title = `${t.title || ''}\n${t.url || ''}`
    te.title.textContent = t.title || 'New Tab'

    const key = t.loading ? 'loading' : t.favicon || siteIcon(t.site)
    if (key !== te.key) {
      te.key = key
      if (t.loading) te.iconSlot.replaceChildren(el('span', 'throbber'))
      else if (t.favicon) {
        const img = el('img', 'favicon')
        img.src = t.favicon
        img.onerror = () => img.replaceWith(icon(siteIcon(t.site), `ico ${siteIcon(t.site)}`))
        te.iconSlot.replaceChildren(img)
      } else te.iconSlot.replaceChildren(icon(siteIcon(t.site), `ico ${siteIcon(t.site)}`))
    }
    if (container.children[i] !== te.n) container.insertBefore(te.n, container.children[i] || null)
  })
}

function render() {
  const active = state.tabs.find(t => t.id === state.activeId)

  renderTabs()

  // nav
  $('back').disabled = !active?.canBack
  $('forward').disabled = !active?.canForward
  $('reloadicon').setAttribute('href', active?.loading ? '#i-stop' : '#i-reload')
  if (!editingAddress) $('address').value = displayUrl(active?.url)
  const site = active?.site
  $('siteicon').firstElementChild.setAttribute('href', `#i-${siteIcon(site)}`)
  $('siteicon').setAttribute('class', siteIcon(site))
  $('siteicon').title = site === 'veil' ? 'Veil internal page' : site ? `Isolated: ${site}` : ''
  $('level').value = state.level

  // address bar extras
  const bookmarkable = !!site && site !== 'veil'
  $('starbtn').hidden = !bookmarkable
  $('starbtn').classList.toggle('on', !!active?.bookmarked)
  $('staricon').setAttribute('href', active?.bookmarked ? '#i-star-on' : '#i-star')
  $('onionbtn').hidden = !active?.onionLocation
  $('zoombadge').hidden = !active || active.zoom === 100
  $('zoombadge').textContent = `${active?.zoom}%`
  const key = JSON.stringify(state.suggestions || [])
  if (key !== lastSuggest) {
    lastSuggest = key
    $('suggest').replaceChildren(...(state.suggestions || []).map(h => {
      const o = el('option')
      o.value = h.url
      o.label = h.title
      return o
    }))
  }

  // find bar
  document.body.classList.toggle('find-open', state.findOpen)
  $('findbar').hidden = !state.findOpen
  const f = active?.find
  $('findcount').textContent = f ? `${f.active} of ${f.matches}` : ''
  $('findinput').classList.toggle('nomatch', !!f && f.matches === 0 && !!$('findinput').value)

  // fullscreen + toast
  document.body.classList.toggle('fullscreen', !!state.fullscreen)
  $('toast').hidden = !state.toast
  $('toast').textContent = state.toast || ''

  // tor status
  const tor = state.tor || {}
  const status = $('torstatus')
  status.className = tor.ready ? 'ready' : ''
  $('tortext').textContent = tor.ready ? 'tor: connected' : tor.error ? 'tor: error' : `tor: ${tor.progress || 0}%`
  status.title = tor.summary || ''
  const bar = $('progressbar')
  bar.style.width = `${tor.progress || 0}%`
  $('progress').hidden = !!tor.ready

  // error page
  $('errorview').hidden = !active?.error
  if (active?.error) $('errortext').textContent = active.error

  // panel
  document.body.classList.toggle('panel-open', state.panelOpen)
  $('panel').hidden = !state.panelOpen
  $('circuitbtn').classList.toggle('on', state.panelOpen)
}

async function refreshCircuit() {
  const { site, circuit } = await api.invoke('circuit') || {}
  const hops = $('hops')
  $('newcircuit').disabled = !site || site === 'veil'
  if (!site || site === 'veil') {
    $('panelsite').textContent = 'Internal Veil page — no network used.'
    hops.replaceChildren()
    $('panelnote').textContent = ''
    return
  }
  $('panelsite').textContent = site
  if (!circuit) {
    hops.replaceChildren()
    $('panelnote').textContent = 'No circuit yet — load the page first.'
    return
  }
  const isOnion = site.endsWith('.onion')
  const roles = isOnion ? ['Guard', 'Middle', 'Rendezvous point'] : ['Guard', 'Middle', 'Exit']
  const items = [hop('you', 'You', 'This browser', 'Your real IP stays here')]
  circuit.hops.forEach((h, i) => {
    items.push(hop('', roles[i] || 'Relay', `${h.nickname || 'relay'}${h.country ? `  [${h.country.toUpperCase()}]` : ''}`,
      h.ip || ''))
  })
  items.push(isOnion
    ? hop('dest', 'Onion service', site, 'Hidden behind its own 3 relays')
    : hop('dest', 'Website', site, 'Sees only the exit relay\'s IP'))
  hops.replaceChildren(...items)
  $('panelnote').textContent = `Circuit #${circuit.id} · ${circuit.purpose}`
}

function hop(cls, role, name, meta) {
  const li = el('li', cls)
  li.append(el('div', 'role', role), el('div', 'name', name), el('div', 'meta', meta))
  return li
}

api.onState(s => {
  const wasOpen = state.panelOpen
  const prevActive = state.activeId
  state = s
  render()
  if (state.panelOpen && (!wasOpen || prevActive !== state.activeId)) refreshCircuit()
  clearInterval(circuitTimer)
  if (state.panelOpen) circuitTimer = setInterval(refreshCircuit, 3000)
})
api.onFocusAddress(() => { $('address').focus(); $('address').select() })
api.onFocusFind(() => setTimeout(() => { $('findinput').focus(); $('findinput').select() }))
api.onFindStep(forward => {
  if (!state.findOpen) { api.invoke('findOpen', true); return setTimeout(() => $('findinput').focus()) }
  findStep(forward)
})

function findStep(forward) {
  const text = $('findinput').value
  if (text) api.invoke('find', text, forward, true)
}
$('findinput').oninput = () => api.invoke('find', $('findinput').value, true, false)
$('findbar').onsubmit = e => { e.preventDefault(); findStep(true) }
$('findinput').onkeydown = e => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(!e.shiftKey) }
  if (e.key === 'Escape') { $('findinput').value = ''; api.invoke('findOpen', false) }
}
$('findnext').onclick = () => findStep(true)
$('findprev').onclick = () => findStep(false)
$('findclose').onclick = () => { $('findinput').value = ''; api.invoke('findOpen', false) }

$('starbtn').onclick = () => api.invoke('bookmark')
$('onionbtn').onclick = () => api.invoke('openOnion')
$('zoombadge').onclick = () => api.invoke('zoom', 0)
$('tabrow').ondblclick = e => { if (e.target.id === 'tabrow' || e.target.id === 'tabs' || e.target.classList.contains('spacer')) api.invoke('newTab') }

$('newtab').onclick = () => api.invoke('newTab')
$('back').onclick = () => api.invoke('back')
$('forward').onclick = () => api.invoke('forward')
$('reload').onclick = () => {
  const active = state.tabs.find(t => t.id === state.activeId)
  api.invoke(active?.loading ? 'stop' : 'reload')
}
$('retry').onclick = () => api.invoke('reload')
$('addressform').onsubmit = e => {
  e.preventDefault()
  editingAddress = false
  api.invoke('navigate', $('address').value)
  $('address').blur()
}
$('address').onfocus = () => { editingAddress = true; setTimeout(() => $('address').select()) }
$('address').onblur = () => { editingAddress = false; render() }
$('address').onkeydown = e => { if (e.key === 'Escape') $('address').blur() }
$('level').onchange = e => api.invoke('setLevel', e.target.value)
$('circuitbtn').onclick = () => api.invoke('panel', !state.panelOpen)
$('closepanel').onclick = () => api.invoke('panel', false)
$('newcircuit').onclick = async () => { await api.invoke('newCircuit'); setTimeout(refreshCircuit, 1500) }
$('identitybtn').onclick = () => api.invoke('newIdentity')
$('panicbtn').onclick = () => api.invoke('panic')
