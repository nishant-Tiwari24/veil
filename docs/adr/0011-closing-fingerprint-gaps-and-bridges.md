# ADR 0011 — Close the remaining fingerprint gaps, add bridges

**Status:** Accepted

## Context
Writing the threat guide (every leak, row by row) exposed gaps: detailed
client-hint headers, installed fonts, system preferences (dark mode etc.),
the real screen size in full screen, an inconsistent pixel-ratio lie, and no
way to connect where Tor is blocked.

## Decision
| Gap | Fix |
|---|---|
| Client hints and network/device headers | Strip `Sec-CH-UA-*` high-entropy hints, `Downlink`, `ECT`, `RTT`, `Save-Data`, `Device-Memory`, `DPR`, `Viewport-Width`, `Width`, `X-Client-Data`; strip `Accept-CH` / `Critical-CH` responses so sites can't opt in |
| System preferences | Engine-level emulation (CDP `Emulation.setEmulatedMedia`): light, no reduced motion/transparency/contrast, no forced colours, so CSS and `matchMedia` agree |
| Screen size | Engine-level screen override (CDP `setDeviceMetricsOverride`, screen only) = the letterboxed page; letterboxing kept in full screen |
| Pixel ratio | Report the real value, like Tor Browser; the old "1" disagreed with CSS `resolution` queries |
| Fonts | Per-OS allowlist (Tor Browser's macOS `font.system.whitelist`) enforced on `element.style` (via a proxy: Chromium has no prototype accessors for CSS properties), `setProperty`, `cssText`, `style` attributes, canvas `font`, and `document.fonts.check`; page-declared web fonts allowed |
| Bridges | obfs4, Snowflake, meek (Tor Browser's `pt_config.json`) or custom lines, run by Tor Browser's signed `lyrebird` (`npm run bridges:setup`); chosen in the Hub, saved in `settings.json` |

## Consequences
- + Every item verified by the self-test (37 checks), bridges verified by a
  Snowflake bootstrap from this network.
- − Fonts are Partial: probes written in page CSS (stylesheets, `@font-face
  local()`) bypass the JavaScript filters.
- − obfs4 built-in bridges didn't connect from this network; Snowflake did.
- − `settings.json` (connection choice) is saved to disk.
