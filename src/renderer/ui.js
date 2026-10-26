const $ = id => document.getElementById(id)
const api = window.veilUI
let state = { tabs: [], activeId: null, tor: {}, level: 'standard', panelOpen: false }
let editingAddress = false
let circuitTimer = null

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function flag(cc) {
  if (!cc || cc.length !== 2) return '🏳️'
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1A5 + c.charCodeAt(0)))
}

function displayUrl(url) {
  return url && url.startsWith('veil://hub') ? '' : url || ''
}

function render() {
  const active = state.tabs.find(t => t.id === state.activeId)

  // tabs
  const tabs = $('tabs')
  tabs.replaceChildren(...state.tabs.map(t => {
    const n = el('div', 'tab' + (t.id === state.activeId ? ' active' : ''))
    if (t.loading) n.append(el('span', 'spin'))
    else if (t.site && t.site.endsWith('.onion')) n.append(el('span', null, '🧅'))
    n.append(el('span', 'title', t.title || 'New Tab'))
    const close = el('button', 'close', '×')
    close.title = 'Close tab'
    close.onclick = e => { e.stopPropagation(); api.invoke('closeTab', t.id) }
    n.append(close)
    n.onmousedown = e => { if (e.button === 0) api.invoke('activate', t.id) }
    n.onauxclick = e => { if (e.button === 1) api.invoke('closeTab', t.id) }
    return n
  }))

  // nav
  $('back').disabled = !active?.canBack
  $('forward').disabled = !active?.canForward
  $('reload').textContent = active?.loading ? '×' : '↻'
  if (!editingAddress) $('address').value = displayUrl(active?.url)
  const site = active?.site
  $('siteicon').textContent = !site || site === 'veil' ? '🛡️' : site.endsWith('.onion') ? '🧅' : '🔒'
  $('siteicon').title = site === 'veil' ? 'Veil internal page' : site ? `Isolated: ${site}` : ''
  $('level').value = state.level

  // tor status
  const tor = state.tor || {}
  const pill = $('torpill')
  pill.className = 'pill' + (tor.ready ? ' ready' : tor.error ? ' error' : '')
  $('tortext').textContent = tor.ready ? 'Connected to Tor' : tor.error ? 'Tor error' : `Tor ${tor.progress || 0}%`
  pill.title = tor.summary || ''
  const bar = $('progressbar')
  bar.style.width = `${tor.progress || 0}%`
  bar.style.opacity = tor.ready ? '0' : '1'

  // error page
  $('errorview').hidden = !active?.error
  if (active?.error) $('errortext').textContent = active.error

  // panel
  document.body.classList.toggle('panel-open', state.panelOpen)
  $('panel').hidden = !state.panelOpen
  $('circuitbtn').classList.toggle('active', state.panelOpen)
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
    items.push(hop('', roles[i] || 'Relay', `${flag(h.country)}  ${h.nickname || 'relay'}`,
      [h.ip, h.country?.toUpperCase()].filter(Boolean).join(' · ')))
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
