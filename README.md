# 🧅 Veil

An anonymous browser built on Tor onion routing. Every request goes through
the Tor network, every site gets its own circuit and storage, nothing is kept,
and communities can host invite-only onion sites with one click.

> ⚠️ **Disclaimer — read this first**
>
> Veil is an **educational project** built for a video. It has **not** been
> security-audited. If your safety depends on staying anonymous (journalists,
> activists, whistleblowers), **use [Tor Browser](https://www.torproject.org/)**,
> not Veil.
>
> - Veil's fingerprint protection is weaker than Tor Browser's. It is built on
>   Chromium and has very few users, so it doesn't blend into a large crowd.
> - No browser can protect you if you log in to personal accounts or share
>   identifying details.
> - Tor protects your privacy; it does not make illegal activity legal. Follow
>   the laws where you live. The authors are not responsible for misuse.
> - Veil is not affiliated with or endorsed by The Tor Project. "Tor" is a
>   trademark of The Tor Project, Inc.

## Run it
```bash
brew install tor          # Veil drives the real tor daemon
npm install
npm start
```
Prove the anonymity guarantees automatically:
```bash
VEIL_SELFTEST=1 npm start
```

## Features

**Everyday browsing**
- Tabs: new, close, drag to reorder, right-click menu (duplicate, close others), reopen closed tab (⌘⇧T), ⌘1–9, Ctrl+Tab
- Address bar that searches privately (DuckDuckGo's onion) and shows your search terms, with suggestions from this session
- Back / forward / reload / stop, Home (⌘⇧H), favicons (fetched through Tor)
- Find in page (⌘F, ⌘G), zoom (⌘+ / ⌘− / ⌘0), print (⌘P), full-screen video
- Right-click menu: open link in new tab, copy link, search selection, copy/paste, inspect
- Bookmarks (⌘D), saved only if you choose to; Panic deletes them
- History (⌘Y), kept in memory for this session only
- Downloads through Tor, with a warning before saving
- Works with normal websites **and** .onion sites; shows ".onion available" when a site has an onion version

**Anonymity**
- All traffic through Tor, with a kill switch (no Tor = nothing loads)
- Per-site Tor circuits and storage: sites can't link you
- No local DNS, no WebRTC, no QUIC: no leaks around Tor
- Amnesic: nothing written to disk
- Fingerprint resistance: uniform UA, UTC timezone, letterboxing, canvas noise, WebGL masking
- Security levels: Standard / Safer / Safest (JavaScript off)
- Live circuit map, New Identity (⌘⇧U), New Circuit (⌘⇧L), **Panic** (⌘⇧X)
- **See onion routing** (⌘⇧O): an animated view of your real circuit, with a packet
  losing one encryption layer per relay, who-sees-what, and live traffic from tor
- **Ad & tracker blocking** (EasyList + EasyPrivacy): the same built-in list for
  every user so it can't fingerprint you; shield badge shows the count, click to
  allow ads on a site for this session
- Built-in leak test
- Community Hub: signed directory, invite-only sites, one-click onion hosting

## Do I still need a VPN?
Not for browsing **inside Veil**: every page already goes through 3 Tor relays,
which hides your IP from websites and hides the sites you visit from your ISP.
But Veil only protects Veil. Other apps on your computer are not covered.

Some websites block or challenge Tor users (CAPTCHAs, banking, some Google
services). That is the site refusing Tor, not a Veil bug. Use ⌘⇧L (new circuit)
to try a different exit relay.

If your country or network blocks Tor itself, you would need Tor bridges. Veil
doesn't support bridges yet.

## Docs
- [Plan](docs/PLAN.md) · [Architecture](docs/ARCHITECTURE.md) · [ADRs](docs/adr) · [TODO](docs/TODO.md)

## Updating the ad-block list
```bash
npm run adblock:update   # rebuilds assets/adblock.engine; do this before each release
```

## Community directory
```bash
npm run community:keygen   # once, creates the signing key (keep community.key secret)
# edit community/directory.json
npm run community:sign     # re-sign after every change
```
