# ADR 0007 — Community network: signed hub, invite-only onions, hosting

**Status:** Accepted

## Context
We want a "community internet": places only members can reach, without
inventing a new (and weaker) anonymity protocol.

## Decision
Build on Tor onion services (v3):
1. **Signed directory.** `community/directory.json` lists community onion
   sites; `directory.sig` is an Ed25519 signature. Veil ships the community
   public key and refuses an unsigned or tampered directory → nobody can
   slip in a phishing onion.
2. **Invite-only sites (client authorization).** Tor v3 client auth: an
   onion service only answers clients holding an x25519 key. Without the key
   the site is unreachable and undiscoverable. Members join by pasting an
   invite: `veil-invite:<onion-address>:<private-key>`. Veil passes it to
   tor with `ONION_CLIENT_AUTH_ADD` (memory only).
3. **One-click hosting.** Veil serves a local folder over 127.0.0.1 and
   publishes it with `ADD_ONION` (optionally with `ClientAuthV3`), then
   prints the invite to share.

## Consequences
- + Uses Tor's audited crypto and its ~7,000-relay network — strong anonymity.
- + Invite-only sites are invisible to the public.
- − Hosted sites live only while Veil is open (ephemeral). Fine for a demo;
  persistent hosting would store the service key.
