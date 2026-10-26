# ADR 0001 — Electron (Chromium) as the browser engine

**Status:** Accepted

## Context
We have 3–4 hours. Tor Browser is a Firefox ESR fork with hundreds of
patches; forking Firefox or Chromium means hours of compile time alone.

## Decision
Build Veil on Electron. Each tab is a `WebContentsView`; the browser UI is a
separate privileged view that never loads web content.

## Consequences
- + Full browser in hours, modern web compatibility, easy per-tab sessions,
  proxies and request filtering from the main process.
- − Chromium fingerprint, not Tor Browser's. Veil users form a small crowd,
  so fingerprint resistance is weaker than Tor Browser (see ADR 0006).
- − We inherit Electron's update cadence for security patches.
