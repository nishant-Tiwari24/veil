# ADR 0004 — Kill switch and leak prevention

**Status:** Accepted

## Context
A proxy alone doesn't guarantee anonymity. Browsers leak through DNS, WebRTC,
UDP (QUIC), prefetching and background requests.

## Decision
Defense in depth — each layer works even if another fails:
1. **No local DNS at all:** `--host-resolver-rules="MAP * ~NOTFOUND"`.
   Chromium cannot resolve any name itself; only tor can.
2. **Fixed proxy, no direct fallback:** each session uses `fixed_servers`
   with our relay. If tor is down, requests fail instead of going direct.
3. **Kill switch in the request filter:** until tor reports 100% bootstrap,
   and for any non-web scheme (`file:`, `ftp:`...), requests are cancelled.
4. **No QUIC/UDP:** `--disable-quic`. Tor only carries TCP.
5. **WebRTC:** IP handling policy `disable_non_proxied_udp` + the API is
   removed from pages.
6. **No prefetch / preconnect / background services:** disabled via
   Chromium switches; no Safe Browsing, no spellcheck downloads.

## Consequences
- + A bug in any single layer doesn't leak the real IP.
- − Video/voice calls (WebRTC) won't work. Intended.
