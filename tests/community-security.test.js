// No Tor daemon needed: exercise Community.host() through its real HTTP server.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { Community } = require('../src/main/community')

const SERVICE_ID = 'a'.repeat(56)

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
      res.on('error', reject)
    }).on('error', reject)
  })
}

test('hosted folders serve public files without disclosing local private files', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-community-test-'))
  const publicDir = path.join(tmp, 'public')
  const privateDir = path.join(tmp, 'private')
  fs.mkdirSync(publicDir)
  fs.mkdirSync(privateDir)
  fs.mkdirSync(path.join(publicDir, 'assets'))
  fs.mkdirSync(path.join(publicDir, 'nested'))
  fs.mkdirSync(path.join(publicDir, '.git'))
  fs.writeFileSync(path.join(publicDir, 'index.html'), 'PUBLIC HOME')
  fs.writeFileSync(path.join(publicDir, 'assets', 'site.css'), 'body { color: red }')
  fs.writeFileSync(path.join(publicDir, 'nested', 'index.html'), 'NESTED HOME')
  fs.writeFileSync(path.join(publicDir, '.env'), 'SENSITIVE_ENV_VALUE')
  fs.writeFileSync(path.join(publicDir, '.git', 'config'), 'SENSITIVE_GIT_CONFIG')
  fs.writeFileSync(path.join(privateDir, 'secret.txt'), 'SENSITIVE_OUTSIDE_FILE')
  fs.writeFileSync(path.join(privateDir, 'index.html'), 'SENSITIVE_OUTSIDE_INDEX')
  fs.symlinkSync(path.join(privateDir, 'secret.txt'), path.join(publicDir, 'file-link.txt'))
  fs.symlinkSync(privateDir, path.join(publicDir, 'dir-link'))
  fs.symlinkSync(path.join(publicDir, 'index.html'), path.join(publicDir, 'internal-link.html'))
  fs.symlinkSync(path.join(publicDir, '.env'), path.join(publicDir, 'hidden-alias.txt'))
  fs.symlinkSync(path.join(publicDir, '.git'), path.join(publicDir, 'git-alias'))

  const control = { command: async () => [`ServiceID=${SERVICE_ID}`] }
  const community = new Community({ getControl: () => control })
  t.after(() => {
    community.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const hosted = await community.host({ folder: publicDir, inviteOnly: false })
  const port = community.hosted.get(hosted.serviceId).server.address().port

  for (const [name, pathname, status, expected] of [
    ['root index', '/', 200, 'PUBLIC HOME'],
    ['normal asset', '/assets/site.css', 200, 'body { color: red }'],
    ['nested index', '/nested/', 200, 'NESTED HOME'],
    ['in-root symlink', '/internal-link.html', 200, 'PUBLIC HOME'],
    ['nonexistent file', '/missing.html', 404, 'Not found'],
    ['hidden env file', '/.env', 403, ''],
    ['percent-encoded hidden file', '/%2Eenv', 403, ''],
    ['git metadata', '/.git/config', 403, ''],
    ['hidden file via in-root symlink', '/hidden-alias.txt', 403, ''],
    ['hidden directory via in-root symlink', '/git-alias/config', 403, ''],
    ['symlink to outside file', '/file-link.txt', 403, ''],
    ['symlink to outside directory', '/dir-link/', 403, ''],
    ['encoded traversal', '/%2e%2e%2fprivate%2fsecret.txt', 403, ''],
    ['malformed escape sequence', '/%ff', 400, ''],
  ]) {
    await t.test(name, async () => {
      const response = await get(port, pathname)
      assert.equal(response.status, status, `${pathname}: ${response.body}`)
      assert.equal(response.body, expected)
    })
  }
})
