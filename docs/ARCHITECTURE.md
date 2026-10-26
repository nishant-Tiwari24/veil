# Veil — Architecture

## What Veil is
A desktop browser that sends **every** request through the real Tor network
(onion routing), isolates every website from every other, keeps nothing on
disk, and lets a community run invite-only onion sites.

Veil does **not** invent a new anonymity network. It drives the real `tor`
software — the same daemon inside Tor Browser — and connects to the public
Tor network of ~7,000 volunteer relays. Inventing a new network would be far
less anonymous: anonymity comes from the size of the crowd.

## Tech stack
| Layer | Tech | Why |
|---|---|---|
| Browser engine | Electron 45 (Chromium) | Full browser in hours (ADR 0001) |
| Anonymity network | `tor` 0.4.9 daemon, spawned by Veil | Real onion routing (ADR 0002) |
| Tor control | Tor control protocol over TCP, cookie auth | Circuits, New Identity, onion hosting |
| Isolation | Custom SOCKS5 relay in Node.js | Per-site circuits (ADR 0003) |
| Community crypto | Ed25519 (directory signing), x25519 (client auth) | ADR 0007 |
| UI | Plain HTML/CSS/JS | No framework needed |

## How a request travels
```
 You type example.com
   │
   ▼
 Tab (Chromium)  ── own in-memory partition for "example.com"
   │  socks5://127.0.0.1:<port for example.com>      (no local DNS — disabled)
   ▼
 IsolationRelay (Node)  ── adds SOCKS auth: user="example.com", pass=<identity nonce>
   │
   ▼
 tor daemon  ── IsolateSOCKSAuth: unique credentials → unique circuit
   │  3 layers of encryption
   ▼
 Guard relay ──► Middle relay ──► Exit relay ──► example.com
 (knows your IP)  (knows nothing)   (knows the site)
```
For a `.onion` site there is no exit: the client and the service each build
3-hop circuits that meet at a rendezvous point. Neither side learns the
other's IP.

## Components (src/main)
- **main.js**: window, tabs, sessions, hardening switches, IPC, identity.
- **tor.js** (`TorManager`): spawns tor with a temp DataDirectory and random
  ports, tracks bootstrap, deletes everything on quit.
- **control.js** (`TorControl`): control-protocol client: `GETINFO
  circuit-status`, `SIGNAL NEWNYM`, `ADD_ONION`, `ONION_CLIENT_AUTH_ADD`.
- **relay.js** (`IsolationRelay`): one local SOCKS listener per site;
  forwards to tor with per-site credentials. Kill switch lives here too.
- **community.js**: signed directory verification, invites, onion hosting.
- **selftest.js**: automated proof of the anonymity guarantees.

## Anonymity layers
1. **Network:** onion routing through 3 relays (tor).
2. **Leak prevention:** no local DNS (`host-resolver-rules`), no QUIC/UDP,
   WebRTC removed, no prefetch, kill switch (nothing loads unless tor is
   connected), fixed proxy with no direct fallback.
3. **Isolation:** per-site circuit + per-site in-memory storage.
4. **Amnesia:** nothing written to disk; tor state is in a temp dir that is
   deleted on quit; New Identity and Panic wipe it all mid-session.
5. **Fingerprint resistance:** uniform UA/platform/language/timezone,
   letterboxing, canvas noise, WebGL masking, security levels.

## Where reverse engineering was used
- **Tor Browser** is open source, so we studied its design (first-party
  isolation via SOCKS auth, letterboxing, security levels, New Identity) and
  rebuilt each one in Veil.
- **tor 0.4.9 binary:** hosting invite-only sites failed with `512 No auth
  type specified` even though the command matched the spec. The strings
  next to that error in the compiled `tor` binary showed an `ADD_ONION` flag
  `V3Auth` that the docs don't mention for this case. Adding
  `Flags=V3Auth` fixed it.

## Unique features (vs Tor Browser / Brave)
- Onion sites in normal tabs, not only private windows (vs Brave).
- Live per-site circuit map with relay countries.
- Built-in leak test that proves isolation (two sites → two exit IPs).
- Signed community directory: can't be tampered with.
- Invite-only community sites (Tor v3 client authorization).
- One-click hosting of a folder as an onion site.
- Panic button: wipes tabs, storage, clipboard, invites, hosted sites.

## Threat model (what Veil does NOT protect against)
- **Fingerprinting by a determined site.** Veil has few users and is built on
  Chromium, so it can't match Tor Browser's huge identical crowd.
- **You identifying yourself:** logging in, or typing personal details.
- **A global adversary** watching both ends of a connection (timing
  correlation). This limitation applies to Tor itself.
- **Browser zero-days.** Use the "Safest" level on untrusted sites.
- **Malware on your computer.**
