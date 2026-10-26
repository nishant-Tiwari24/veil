// VEIL_SELFTEST=1 npm start — verifies the anonymity guarantees, prints results, quits.
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function runSelfTest({ tor, networkTest, createTab, circuitInfo, community, pageProbe, newCircuit, browser }) {
  const results = []
  const check = (name, ok, detail) => {
    results.push(ok)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  }

  await waitFor(() => tor.ready, 120000, 'tor bootstrap')
  console.log('tor bootstrapped')

  const net = await networkTest()
  check('traffic exits via Tor', net.tor?.IsTor === true, net.tor?.IP || net.tor?.error)
  check('two sites get different exit IPs', !!net.tor?.IP && net.tor.IP !== net.isolated?.IP,
    `${net.tor?.IP} vs ${net.isolated?.IP}`)
  check('local DNS is impossible', net.dns?.blocked === true)

  const tab = createTab('https://check.torproject.org/')
  await waitFor(() => tab.view && !tab.loading && tab.title && tab.title !== 'New Tab', 60000, 'page load')
  const html = await tab.view.webContents.executeJavaScript('document.body.innerText')
  check('check.torproject.org page says Congratulations', /Congratulations/i.test(html))
  const { circuit } = await circuitInfo()
  check('circuit visible for site', circuit?.hops?.length === 3,
    circuit?.hops?.map(h => `${h.nickname}(${h.country || '?'})`).join(' → '))

  const fp = await pageProbe(tab)
  check('timezone is UTC', fp.offset === 0, `${fp.tz}, offset ${fp.offset}`)
  check('WebRTC removed', fp.rtc === 'undefined')
  check('platform spoofed', fp.platform === 'Win32')
  check('screen = viewport', fp.screen === fp.inner, `${fp.screen} / ${fp.inner}`)

  // --- everyday browser features ---
  browser.ui.find('Tor', true, false)
  const found = await waitFor(() => tab.find?.matches > 0 && tab.find, 10000, 'find').catch(() => null)
  check('find in page', !!found, found && `${found.matches} matches for "Tor"`)
  browser.ui.findOpen(false)

  browser.ui.zoom(1)
  check('zoom in', tab.zoom === 0.5 && Math.abs(tab.view.webContents.getZoomLevel() - 0.5) < 0.01)
  browser.ui.zoom(0)

  browser.ui.bookmark()
  const marked = browser.bookmarks.has(tab.url)
  browser.ui.bookmark()
  check('bookmark toggle', marked && !browser.bookmarks.has(tab.url))

  check('session history recorded', browser.history().some(h => h.url.startsWith('https://check.torproject.org')))

  const before = browser.tabCount()
  browser.closeTab(tab.id)
  browser.ui.reopenClosed()
  check('reopen closed tab', browser.tabCount() === before)

  // Click the real × of a tab with OS-level mouse events, the way a user does.
  createTab('veil://hub/')
  await new Promise(r => setTimeout(r, 800))
  const beforeClose = browser.tabCount()
  const box = await browser.uiView.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('#tabs .tab:last-child .close').getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  for (const type of ['mouseDown', 'mouseUp']) {
    browser.uiView.webContents.sendInputEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  await new Promise(r => setTimeout(r, 800))
  check('clicking × closes the tab', browser.tabCount() === beforeClose - 1, `${beforeClose} → ${browser.tabCount()} tabs`)

  // Ad & tracker blocking: the engine, then a real ad-heavy page through Tor
  const req = url => browser.adblock.check({ url, resourceType: 'script', referrer: 'https://example.com/' }, 'example.com')
  const ad = req('https://securepubads.g.doubleclick.net/tag/js/gpt.js')
  const pixel = browser.adblock.check({ url: 'https://ad.doubleclick.net/ddm/ad/x.gif', resourceType: 'image', referrer: 'https://example.com/' }, 'example.com')
  const own = req('https://example.com/app.js')
  check('ad blocker: ads stopped, site scripts untouched', !!ad?.redirectURL && pixel?.cancel === true && own === null,
    'gpt.js → no-op stand-in, ad pixel → blocked, app.js → allowed')
  const adTab = createTab('https://www.theguardian.com/international')
  await waitFor(() => adTab.view && !adTab.loading && adTab.title !== 'New Tab', 90000, 'ad page').catch(() => {})
  await new Promise(r => setTimeout(r, 3000))
  check('ads & trackers blocked on a real page', adTab.blocked > 0, `${adTab.blocked} blocked on theguardian.com`)
  await new Promise(r => setTimeout(r, 600))
  const badge = await browser.uiView.webContents.executeJavaScript(
    `({ hidden: document.getElementById('adblockbtn').hidden, text: document.getElementById('adblockcount').textContent })`)
  check('shield badge shows the count in the toolbar', !badge.hidden && Number(badge.text) === adTab.blocked, `badge: ${badge.text}`)

  const olTab = createTab('https://www.torproject.org/')
  const ol = await waitFor(() => olTab.onionLocation, 60000, 'Onion-Location').catch(() => null)
  check('".onion available" detected', !!ol, ol)

  const site = await community.host({ folder: require('path').join(__dirname, '..', '..', 'community', 'sample-site'), inviteOnly: true })
  check('onion service published', /^[a-z2-7]{56}$/.test(site.serviceId), site.url)
  check('invite generated', /^veil-invite:/.test(site.invite || ''))

  // End to end: load our own invite-only onion through Tor (descriptor takes a while to publish)
  const onionTab = createTab(site.url)
  // Retry on a fresh circuit each time so a failed attempt isn't cached.
  const reached = await waitFor(async () => {
    if (!onionTab.view || onionTab.loading) return false
    const text = await onionTab.view.webContents.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '')
    if (/You made it/.test(text)) return true
    await new Promise(r => setTimeout(r, 10000))
    await newCircuit()
    return false
  }, 300000, 'onion site').catch(() => false)
  check('invite-only onion site reachable over Tor', reached)

  const failed = results.filter(r => !r).length
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL CHECKS PASSED')
  return failed
}

module.exports = { runSelfTest }
