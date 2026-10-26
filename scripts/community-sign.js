// Signs community/directory.json -> community/directory.sig (Ed25519).
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, '..', 'community')
const key = crypto.createPrivateKey(fs.readFileSync(path.join(dir, 'community.key')))
const data = fs.readFileSync(path.join(dir, 'directory.json'))
const sig = crypto.sign(null, data, key).toString('base64')
fs.writeFileSync(path.join(dir, 'directory.sig'), sig + '\n')
console.log('Signed directory.json')
