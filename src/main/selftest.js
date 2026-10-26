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

async function runSelfTest({ tor, networkTest, createTab, circuitInfo, community, pageProbe, newCircuit }) {
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
