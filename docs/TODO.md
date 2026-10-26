# Veil — TODO

## Phase 0 — Setup
- [x] Project folder, git
- [x] PLAN + ADRs
- [x] Install tor (Homebrew), npm init, Electron

## Phase 1 — Browser shell
- [x] Window with toolbar view + tab views
- [x] Tabs: new / close / switch
- [x] Address bar, back / forward / reload
- [x] `veil://` internal pages (hub, leaktest)

## Phase 2 — Tor
- [x] TorManager: spawn tor, temp DataDirectory, random ports
- [x] Bootstrap progress shown in UI
- [x] Control port client (cookie auth)

## Phase 3 — Anonymity core
- [x] SOCKS isolation relay (per-site credentials)
- [x] Per-site in-memory partitions
- [x] Kill switch: block until bootstrapped, no direct fallback
- [x] No local DNS, no QUIC, WebRTC blocked, no prefetch

## Phase 4 — Fingerprinting
- [x] Uniform UA, language, timezone
- [x] Letterboxing
- [x] Canvas noise, WebGL masking, hardware values
- [x] Security levels: Standard / Safer / Safest

## Phase 5 — Identity tools
- [x] Circuit viewer (per site: guard → middle → exit + countries)
- [x] New Identity
- [x] Panic button (Cmd+Shift+X)
- [x] Leak test page

## Phase 6 — Community
- [x] Signed directory + signing script
- [x] Hub page listing community sites
- [x] Join via invite (client auth)
- [x] One-click hosting (+ invite-only option)

## Phase 7 — Verify
- [x] check.torproject.org says "using Tor"
- [x] DNS leak test clean
- [x] WebRTC leak test clean
- [x] Two sites → two different exit IPs
- [x] Host an invite-only onion, open it from a second tor instance via invite

## Phase 8 — Everyday browser
- [x] Chrome 2008 look: light chrome, slanted tabs, Segoe UI/Tahoma, red accent
- [x] Tab drag-reorder, tab context menu, reopen closed tab, ⌘1–9, Ctrl+Tab
- [x] Page context menu, find in page, zoom, print, full screen
- [x] Favicons through Tor, search terms shown in the address bar
- [x] Bookmarks (opt-in, wiped by Panic), session-only history + suggestions
- [x] Downloads with an IP-leak warning
- [x] Onion-Location (".onion available")
- [ ] Tor bridges (obfs4/snowflake) for networks that block Tor
