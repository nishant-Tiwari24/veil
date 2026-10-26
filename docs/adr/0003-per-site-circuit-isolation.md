# ADR 0003 — Per-site circuit isolation via a SOCKS auth relay

**Status:** Accepted

## Context
If every site shares one Tor circuit, they all see the same exit IP and can
correlate a user across sites. Tor Browser solves this with "first-party
isolation": it sends a different SOCKS username per first-party domain and
tor (with `IsolateSOCKSAuth`) builds a separate circuit for each.

Chromium's SOCKS5 client does **not** support username/password auth, so we
can't do this directly.

## Decision
Run a tiny SOCKS5 relay in the main process:
- One local listener per first-party site (eTLD+1, e.g. `example.com`).
- Each tab's session proxies to that site's listener (`socks5://`, so
  hostnames are resolved by tor, never locally).
- The relay forwards the CONNECT to tor with
  `username = <site>`, `password = <identity nonce>`.
- New Identity rotates the nonce → every site gets fresh circuits.

Third-party requests (trackers, CDNs) inside a site use that site's circuit,
so a tracker embedded on two sites sees two different exit IPs.

## Consequences
- + Same isolation model as Tor Browser.
- − One extra local hop per connection (negligible).
