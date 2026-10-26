# ADR 0005 — Amnesic, per-site storage

**Status:** Accepted

## Context
Cookies, localStorage, cache and IndexedDB let trackers follow users across
sites and across sessions.

## Decision
- Each first-party site gets its own Electron **in-memory partition**
  (`veil-<site>-<nonce>`, no `persist:` prefix) → nothing written to disk.
- Navigating a tab to a different site moves it to that site's partition
  (the tab's view is recreated).
- New Identity / Panic: close all tabs, clear every partition, rotate nonce,
  `SIGNAL NEWNYM`.
- Tor's DataDirectory is a temp dir deleted on quit (ADR 0002).
- No history, no bookmarks, no downloads folder by default.

## Consequences
- + Close Veil and nothing remains.
- − Users are logged out of everything on restart. Intended.
