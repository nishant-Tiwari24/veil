# ADR 0010 — Match Tor Browser where reverse engineering showed gaps

**Status:** Accepted

## Context
We took apart Tor Browser 15.0.26 (see `docs/REVERSE_ENGINEERING.md`): its
455 hardening prefs, `TorDomainIsolator`, `TorProcess`, `newidentity.js`,
`SecurityLevel`, and a measured fingerprint side by side with Veil.

## Decision
Adopt everything Electron/Chromium lets us do without engine patches:

| Tor Browser does | Veil change |
|---|---|
| Reports the real OS *family* with generic values | UA/platform/client hints now per-OS bucket (macOS/Windows/Linux) instead of always "Windows" |
| `dom.netinfo.enabled=false`, `dom.serviceWorkers.enabled=false` | `navigator.connection` and `navigator.serviceWorker` removed |
| `webgl.enable-webgl2=false` | WebGL2 contexts refused |
| Timer precision 16.67 ms (RFP) | `performance.now()`, `Event.timeStamp`, rAF clamped to 16.67 ms |
| `https_only_mode=true`, onions exempt | Top-level `http://` upgraded to `https://`; "Continue to HTTP" per host, session only |
| `referer.hideOnionSource=true`, `XOriginTrimmingPolicy=2` | `.onion` documents forced to `Referrer-Policy: same-origin`; cross-origin Referer trimmed to origin |
| SocksPort `ExtendedErrors IPv6Traffic PreferIPv6 KeepAliveIsolateSOCKSAuth` | Same flags; relay decodes `0xF0–0xF7` into specific onion error messages |
| `DormantCanceledByStartup 1` | Same |
| Safer level: NoScript blocks JS on non-HTTPS | Safer: no JavaScript on plain-HTTP pages (onions count as secure) |

Confirmed unchanged: per-site circuits via SOCKS `username = first-party
domain`, `password = nonce` is exactly Tor Browser's design (ADR 0003).

## Not adopted (and why)
- Bundled font whitelist, JIT-off in Safer, MathML/SVG toggles: need
  Chromium engine patches; Electron doesn't expose them per tab.
- `DisableNetwork 1` until the user clicks Connect: launching Veil is the
  consent; revisit if Veil gets a first-run screen.
- Pluggable transports / bridges: tracked in TODO.
