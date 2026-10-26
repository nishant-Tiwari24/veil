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
- All traffic through Tor, with a kill switch (no Tor = nothing loads)
- Per-site Tor circuits and storage: sites can't link you
- No local DNS, no WebRTC, no QUIC: no leaks around Tor
- Amnesic: nothing written to disk
- Fingerprint resistance: uniform UA, UTC timezone, letterboxing, canvas noise, WebGL masking
- Security levels: Standard / Safer / Safest (JavaScript off)
- Live circuit map, New Identity (⌘⇧U), New Circuit (⌘⇧L), **Panic** (⌘⇧X)
- Built-in leak test
- Community Hub: signed directory, invite-only sites, one-click onion hosting

## Docs
- [Plan](docs/PLAN.md) · [Architecture](docs/ARCHITECTURE.md) · [ADRs](docs/adr) · [TODO](docs/TODO.md)

## Community directory
```bash
npm run community:keygen   # once, creates the signing key (keep community.key secret)
# edit community/directory.json
npm run community:sign     # re-sign after every change
```
