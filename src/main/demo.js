// VEIL_DEMO="url1,url2" npm start — opens each URL in a tab once Tor is ready
// and saves screenshots (toolbar + page) to VEIL_SHOTS (default: ./shots).
const fs = require('fs')
const path = require('path')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitLoaded(tab, ms) {
  const end = Date.now() + ms
  await sleep(1500)
  while (Date.now() < end && (tab.loading || !tab.view)) await sleep(500)
  await sleep(2500) // let the page paint
}

async function runDemo({ tor, urls, createTab, uiView, outDir, activate, setPanel }) {
  uiView.webContents.setBackgroundThrottling(false) // keep the toolbar painting while the window is behind others
  while (!tor.ready) await sleep(500)
  fs.mkdirSync(outDir, { recursive: true })
  for (const [i, url] of urls.entries()) {
    const tab = createTab(url)
    await waitLoaded(tab, 90000)
    setPanel(true)
    await sleep(3500) // circuit panel refresh
    const name = String(i + 1).padStart(2, '0') + '-' + (tab.site || 'page').replace(/[^a-z0-9.-]/gi, '_')
    const shoot = async (wc, file) => {
      for (let i = 0; i < 5; i++) { // a view that hasn't painted yet throws; retry
        try {
          const img = await wc.capturePage()
          if (!img.isEmpty()) return fs.writeFileSync(path.join(outDir, file), img.toPNG())
        } catch {}
        await sleep(1000)
      }
    }
    uiView.webContents.invalidate()
    await sleep(500)
    await shoot(uiView.webContents, `${name}-ui.png`)
    if (tab.view && !tab.error) await shoot(tab.view.webContents, `${name}-page.png`)
    console.log(`DEMO ${tab.error ? 'ERROR' : 'OK   '} ${url}  ${tab.error || tab.title}`)
    setPanel(false)
  }
  activate(urls.length)
  console.log('DEMO DONE')
}

module.exports = { runDemo }
