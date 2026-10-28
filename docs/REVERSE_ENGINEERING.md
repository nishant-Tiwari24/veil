# Reverse engineering Tor Browser 15.0.26

What we took apart, how, what we found, and what Veil changed because of it.
Every step can be re-run (and screen-recorded) with the commands below.
The working files live in `~/Desktop/veil-re/`.

## 0. Get the real thing and prove it's genuine
```bash
curl -s https://aus1.torproject.org/torbrowser/update_3/release/downloads.json   # current version: 15.0.26
curl -O https://dist.torproject.org/torbrowser/15.0.26/tor-browser-macos-15.0.26.dmg
curl -O https://dist.torproject.org/torbrowser/15.0.26/tor-browser-macos-15.0.26.dmg.asc
gpg --auto-key-locate nodefault,wkd --locate-keys torbrowser@torproject.org
#   -> EF6E 286D DA85 EA2A 4BA7  DE68 4E2C 6E87 9329 8290 (Tor Browser Developers)
gpg --verify tor-browser-macos-15.0.26.dmg.asc tor-browser-macos-15.0.26.dmg
#   -> Good signature from "Tor Browser Developers (signing key)"
```

## 1. The app bundle
```bash
hdiutil attach -nobrowse -readonly -mountpoint ./mnt tor-browser-macos-15.0.26.dmg
cp -R "mnt/Tor Browser.app" app/ && hdiutil detach ./mnt
```
| Found | Meaning |
|---|---|
| `Contents/MacOS/firefox`, `application.ini`: Firefox **140.17.0** | Tor Browser is a patched **Firefox ESR** |
| `Contents/MacOS/Tor/tor` (tor **0.4.9.14**) | The same tor version Veil uses |
| `Tor/PluggableTransports/lyrebird`, `conjure-client` | Traffic disguises (obfs4, snowflake, webtunnel, meek, conjure) for countries that block Tor |
| `Resources/fonts/` – **124 Noto fonts** + README: *"Any adjustment to bundled fonts will result in an altered fingerprint"* | Everyone gets identical fonts |
| `distribution/extensions/{73a6fe31-…}.xpi` | **NoScript**, which implements the security levels |
| `TorBrowser/Tor/torrc-defaults` | See below |

**torrc-defaults** (vs Veil):
```
AvoidDiskWrites 1               # Veil: same
Log notice stdout               # Veil: same
CookieAuthentication 1          # Veil: same
DormantCanceledByStartup 1      # Veil: missing -> added
ClientTransportPlugin ... lyrebird / conjure   # Veil: missing (no bridges yet)
```

## 2. The hidden settings (`omni.ja`)
`omni.ja` is a zip archive with Firefox's internals. Tor Browser has two.
```bash
unzip -q app/.../Resources/omni.ja -d omni/toolkit
unzip -q app/.../Resources/browser/omni.ja -d omni/browser
wc -l omni/browser/defaults/preferences/000-tor-browser.js   # 1002 lines, 455 prefs
```
The most important of the **455** changes, grouped:

| Area | Tor Browser setting | Why (their bug #) | Veil |
|---|---|---|---|
| Isolation | `privacy.firstparty.isolate = true` | every site separated | ✅ already (per-site partitions) |
| Fingerprinting | `privacy.resistFingerprinting = true` (locked) | uniform values | ✅ mostly, gaps below |
| Fingerprinting | `privacy.resistFingerprinting.letterboxing = true`, `.vcenter`, `.gradient` | window size rounding | ✅ already |
| Fingerprinting | `webgl.enable-webgl2 = false` | #16404 | ❌ → fixed |
| Fingerprinting | `dom.netinfo.enabled = false` | Network Information API | ❌ → fixed |
| Fingerprinting | `gfx.bundled-fonts.activate = 1`, `font.system.whitelist` | #40342 | ⚠️ not possible in Chromium without patches |
| Fingerprinting | `dom.postMessage.sharedArrayBuffer… = false` | high-res timers | ✅ already absent |
| DNS | `network.proxy.socks_remote_dns = true`, `network.dns.disabled = true` | #5741 DNS leaks | ✅ already (resolver disabled) |
| Proxy | `network.proxy.failover_direct = false` (locked), `allow_bypass = false` | #40548 | ✅ already (fixed proxy, kill switch) |
| HTTP/3 | `network.http.http3.enable = false` | Tor has no UDP | ✅ already (`--disable-quic`) |
| WebRTC | `media.peerconnection.enabled = false` + 5 defence-in-depth prefs | IP leaks | ✅ already |
| Prefetch | `network.predictor.enabled = false`, `dns.disablePrefetch`… | #16633, #42684 | ✅ already |
| HTTPS | `dom.security.https_only_mode = true`, onions exempt | #19850 | ❌ → fixed |
| Referer | `network.http.referer.hideOnionSource = true` | #22320 onion leaks | ❌ → fixed |
| Referer | `referer.XOriginTrimmingPolicy = 2` | #17228 | ❌ → fixed |
| Service workers | `dom.serviceWorkers.enabled = false` | persistence | ❌ → fixed |
| Tracking protection | `privacy.trackingprotection.enabled = false` | #17898 – blocking lists make users distinguishable | ⚠️ Veil blocks ads; mitigated by one fixed list for all users (ADR 0009) |
| Telemetry | ~40 prefs, IDs forced to canary values like `c0ffeec0-ffee-…` | | ✅ Electron has none |

## 3. Per-site circuits: `TorDomainIsolator.sys.mjs`
Found in `omni/toolkit/modules/`. The proxy filter for every request does:
```js
username: `${firstPartyDomain}:${userContextId}`          // e.g. "example.com:0"
password: nonceForDomain + nonceForUserContextId          // random, rotated on New Identity / New Circuit
```
and tor (with `IsolateSOCKSAuth`) builds one circuit per username+password.
**This is exactly Veil's design (ADR 0003)**, confirmed against the real code.
Extra detail: requests with no first party go to a `--unknown--` catch-all
circuit that rotates every **10 minutes** (`CATCHALL_MAX_LIFETIME = 600_000`).

## 4. How it drives tor: `TorProcess` / `TorControlPort` / `TorProvider`
- tor is started with **`DisableNetwork 1`** – no network until the user clicks Connect.
- Ports are passed as `+__SocksPort` / `+__ControlPort` – the `__` keeps them out of any saved torrc.
- SOCKS port flags: **`ExtendedErrors IPv6Traffic PreferIPv6 KeepAliveIsolateSOCKSAuth`**
  (Veil had only `IsolateSOCKSAuth` → updated).
- Control commands used: `AUTHENTICATE`, `TAKEOWNERSHIP`, `RESETCONF __OwningControllerProcess`,
  `GETINFO`, `GETCONF`, `SETCONF`, `SETEVENTS CIRC STREAM STATUS_CLIENT …`, `SIGNAL NEWNYM`.
  It listens to circuit/stream **events**; Veil polls `GETINFO circuit-status`.
- Onion client auth keys go to a `ClientOnionAuthDir` on disk; Veil keeps them in memory only.

## 5. New Identity: `newidentity.js`
Order of operations:
1. **Disable JavaScript in every tab, stop all loads, reset `window.name`** (so a page can't act during the wipe)
2. Close tabs, clear search/find bars, session history, HTTP auth, crypto tokens,
   OCSP cache, HSTS, image caches, disk+memory cache, cookies, storage,
   permissions, site zoom, then `clearData(CLEAR_ALL ^ CLEAR_PASSWORDS)`
3. Close connections, open a fresh window, close the old one
4. Broadcast → the domain isolator clears every nonce → new circuits
Veil: destroys every tab's renderer and session, rotates all nonces, `SIGNAL NEWNYM` — equivalent.

## 6. Security levels: `SecurityLevel.sys.mjs`
| Pref | Safest | Safer | Standard |
|---|---|---|---|
| `javascript.options.ion` / `baselinejit` / `native_regexp` / `asmjs` (JIT) | off | off | on |
| `mathml.disabled` | on | on | off |
| `svg.disabled` | on | off | off |
| graphite / OpenType-SVG fonts | off | off | on |
plus NoScript: **Safer = no JavaScript on non-HTTPS sites**, click-to-play media; **Safest = no JavaScript at all**.
Veil: Safer lacked the HTTP-JS rule → added. Per-tab JIT control isn't available in Electron (documented gap).

## 7. Measured fingerprint: Tor Browser vs Veil
Same test page (`fingerprint/fp.html`): Tor Browser run headless (`firefox --headless --screenshot`),
Veil run in a real web tab (`VEIL_FP=fp.html npm start`).

| What a site sees | Tor Browser | Veil before | Veil after |
|---|---|---|---|
| OS in user agent | Mac (generic `Intel Mac OS X 10.15`) | **Windows** (inconsistent with Mac fonts) | Mac (generic, matches real OS family) |
| timezone / offset | `Atlantic/Reykjavik` / 0 | `UTC` / 0 | `UTC` / 0 |
| `navigator.connection` | undefined | **object** | undefined |
| `navigator.serviceWorker` | undefined | **object** | undefined |
| WebGL2 | false | **true** | false |
| `performance.now()` precision | **16.67 ms** | **0.1 ms** | 16.67 ms |
| WebRTC / battery / mediaDevices | undefined | undefined | undefined |
| screen = window | yes | yes | yes |

**Lesson:** Tor Browser doesn't pretend to be another OS. The OS leaks anyway (fonts,
rendering), so lying just makes you unique. It puts users into per-OS buckets instead.

Screenshot of Tor Browser's measured fingerprint: `docs/re/torbrowser-fingerprint.png`.
Test page: `docs/re/fp.html`.

## 8. Discovered along the way: a hidden flag in the tor binary
Hosting invite-only onion sites failed with `512 No auth type specified` even
though `ADD_ONION … ClientAuthV3=<key>` matches the spec. `strings` on the tor
binary showed the error sits right next to an `ADD_ONION` flag list containing
`V3Auth`. Adding `Flags=V3Auth` fixed it.
```bash
strings $(brew --prefix tor)/bin/tor | grep -n -B12 "No auth type specified"
```

## What Veil changed because of this (ADR 0010)
| Gap found | Fix | Verified by self-test |
|---|---|---|
| UA said Windows on a Mac | per-OS bucket, generic values | `OS family consistent (UA vs platform)` |
| `navigator.connection`, `serviceWorker` exposed | removed | `navigator.connection & serviceWorker removed` |
| WebGL2 on | disabled | `WebGL2 disabled` |
| 0.1 ms timers | 16.67 ms | `timer coarsened to 16.67 ms` |
| no HTTPS-Only | upgrade + "Continue to HTTP" | `HTTPS-Only upgrades http:// to https://` |
| onion address could leak via Referer | `Referrer-Policy: same-origin` on onion pages | `onion address never leaks via Referer` (httpbin saw none) |
| generic onion errors | `ExtendedErrors` decoded | `specific onion error message` |
| missing SOCKS/tor flags | `KeepAliveIsolateSOCKSAuth ExtendedErrors IPv6Traffic PreferIPv6`, `DormantCanceledByStartup 1` | — |
| Safer allowed JS on HTTP | blocked, like NoScript | — |

Still different from Tor Browser (needs engine patches): bundled fonts,
per-tab JIT control, MathML/SVG toggles, and the size of the crowd.
