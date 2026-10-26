# Veil — Build Plan

An anonymous browser built on onion routing. Every request goes through Tor,
every site is isolated, nothing touches disk, and a community can run its own
invite-only "internet" of onion services.

**Time budget:** 3–4 hours. **Builder:** Claude Code.

## Goals
1. All traffic routed through Tor — no exceptions, no fallback.
2. Sites can't link your activity (separate circuit + storage per site).
3. Amnesic: close the app and everything is gone.
4. Reduce fingerprinting using the same ideas as Tor Browser.
5. Community layer: signed directory of onion sites, invite-only onion
   services, one-click hosting.

## Non-goals (said honestly in the video)
- Matching Tor Browser's fingerprint crowd (millions of identical users).
- Defending against a global adversary watching both ends (Tor can't either).
- Shipping signed/notarized installers.

## Architecture

```
┌──────────────────────────── Veil (Electron) ────────────────────────────┐
│  UI (toolbar, tabs, circuit panel)        Tabs (one WebContentsView each)│
│        │ IPC                                     │ in-memory partition   │
│        ▼                                         │ per first-party site  │
│  Main process ───────────────────────────────────┘                       │
│   ├─ TorManager     spawns tor, ephemeral DataDirectory, bootstrap       │
│   ├─ Control        talks to tor ControlPort (circuits, NEWNYM, onions)  │
│   ├─ IsolationRelay one local SOCKS port per site → tor with SOCKS auth  │
│   ├─ Hardening      kill switch, no DNS, no QUIC, WebRTC, fingerprinting │
│   └─ Community      signed directory, client auth, onion hosting         │
└──────────────────────────────────────┬───────────────────────────────────┘
                                       ▼
                         tor  →  guard → middle → exit / .onion
```

## Process
1. Write ADRs (docs/adr) — decisions before code.
2. Build in phases from TODO.md, smallest working thing first.
3. After each phase: run it, verify, commit.
4. Final: leak tests (Tor check, DNS, WebRTC), then record.

## Phases (see TODO.md)
| # | Phase | Est. |
|---|-------|------|
| 1 | Shell: window, tabs, address bar | 40m |
| 2 | Tor: spawn, bootstrap, route traffic | 30m |
| 3 | Anonymity: isolation relay, kill switch, leaks, amnesia | 40m |
| 4 | Fingerprinting + security levels | 25m |
| 5 | Circuit viewer, New Identity, panic, leak test | 30m |
| 6 | Community hub, invites, one-click hosting | 45m |
| 7 | Test + polish | 20m |
