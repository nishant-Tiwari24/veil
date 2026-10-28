Veil is an anonymous browser inspired by Tor Browser. It runs every request through the real Tor network, gives every site its own circuit and storage, and keeps nothing.

> ⚠️ Educational project, not security-audited. If your safety depends on anonymity, use [Tor Browser](https://www.torproject.org/).

## Highlights
- **Per-site Tor circuits**: every site gets its own route through Tor, the same isolation trick Tor Browser uses, found by reverse engineering it
- **Leak protection**: kill switch, no DNS leaks, WebRTC removed, HTTPS-Only
- **Fingerprint resistance**: letterboxing, UTC/en-US, generic user agent, canvas noise, font allowlist, blurred timers, stripped client hints
- **Live circuit viewer and onion-routing visualiser** (`veil://routing`)
- **Built-in ad and tracker blocker** (one fixed list for every user)
- **Community hub**: signed onion directory, one-click onion hosting, invite-only sites
- **Bridges**: obfs4, Snowflake and meek, for places where Tor is blocked
- **Dark horror theme**
- **37-check self-test**: `VEIL_SELFTEST=1 npm start`

## Run it (macOS)
```bash
brew install tor
npm install
npm run bridges:setup   # optional, for bridges
npm start
```

## Downloads
- **macOS**: `Veil-<version>-mac-arm64.dmg` (Apple Silicon) or `-mac-x64.dmg` (Intel). The app is unsigned: right-click → **Open** the first time. Requires `brew install tor`.
- **Linux**: `Veil-<version>-linux-x86_64.AppImage`, then `chmod +x` it. Requires tor (`sudo apt install tor`).
