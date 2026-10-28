// npm run check: syntax-check every source file and make sure the bundled data is intact.
const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const fail = msg => { console.error(`✗ ${msg}`); process.exitCode = 1 }

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
}

// JavaScript files, plus the inline <script> of every internal page
for (const file of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'scripts'))]) {
  if (file.endsWith('.js')) {
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }) } catch (e) { fail(`${file}\n${e.stderr}`) }
  } else if (file.endsWith('.html')) {
    for (const [, code] of fs.readFileSync(file, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      try { new Function(code) } catch (e) { fail(`${path.relative(root, file)}: ${e.message}`) }
    }
  }
}

// The community directory must carry a valid signature
const dir = path.join(root, 'community')
const ok = crypto.verify(null, fs.readFileSync(path.join(dir, 'directory.json')),
  fs.readFileSync(path.join(dir, 'community.pub.pem')), Buffer.from(fs.readFileSync(path.join(dir, 'directory.sig'), 'utf8').trim(), 'base64'))
if (!ok) fail('community/directory.json signature does not verify')

for (const f of ['assets/adblock.engine', 'assets/pt_config.json', 'assets/fonts/Creepster-Regular.ttf']) {
  if (!fs.existsSync(path.join(root, f))) fail(`missing ${f}`)
}
if (!process.exitCode) console.log('✓ all checks passed')
