# ADR 0002 — Veil manages its own tor process

**Status:** Accepted

## Context
Tor Browser ships its own `tor` binary and starts it with a generated config.
Relying on a user's system tor would mean unknown config and shared state.

## Decision
- Veil spawns `tor` itself (Homebrew `tor` for development; bundled binary
  for release, found via `VEIL_TOR_PATH` or PATH).
- Fresh **temporary DataDirectory** per launch, deleted on quit.
- Random free ports for `SocksPort` and `ControlPort`, bound to 127.0.0.1.
- ControlPort uses **cookie authentication**.
- `SocksPort ... IsolateSOCKSAuth` so different SOCKS credentials get
  different circuits (ADR 0003).
- `GeoIPFile` set when available so the circuit viewer can show countries.

## Consequences
- + No leftover Tor state between sessions (fits amnesia, ADR 0005).
- − Every launch bootstraps from scratch (~5–20 s). Acceptable.
