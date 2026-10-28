# ADR 0009 — Built-in ad & tracker blocking with one fixed list

**Status:** Accepted

## Context
Ads and trackers slow pages down over Tor and try to follow users. But Tor
Browser deliberately ships *without* an ad blocker: if users block different
things, websites can tell them apart by what fails to load (a fingerprint).

## Decision
- Block ads and trackers with Ghostery's open-source engine
  (`@ghostery/adblocker`) using EasyList + EasyPrivacy + uBlock filters.
- The list is compiled at **build time** (`npm run adblock:update`) into
  `assets/adblock.engine` and shipped with Veil. The browser never downloads
  lists itself, so every Veil user blocks exactly the same things, and there
  are no direct non-Tor connections to list servers.
- **No custom lists.** Users can only allow ads on a site for the current
  session (not saved), to fix breakage.
- Where the list provides a harmless stand-in for a script (e.g. a no-op
  `analytics.js`), Veil serves that instead of blocking, so pages don't break.
- Element-hiding CSS is injected to remove empty ad boxes.

## Consequences
- + Faster pages over Tor, less tracking, cleaner pages.
- + Uniform across all Veil users.
- − Veil users still differ from Tor Browser users (who block nothing). Veil
  already differs from Tor Browser (Chromium engine), so this costs little.
- − The list ages: rebuild it with each release.
