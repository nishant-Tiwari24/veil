# ADR 0006 — Fingerprint resistance and security levels

**Status:** Accepted

## Context
Sites can identify a user without their IP by measuring the browser:
screen size, timezone, language, fonts, canvas, WebGL GPU strings.
Tor Browser's answer is uniformity: make every user look the same.

## Decision
Copy Tor Browser's approach where Electron allows it:
- **Uniform user agent** (common Chrome on Windows) + `Accept-Language: en-US`.
- **Timezone UTC**, locale `en-US`.
- **Letterboxing:** page viewport rounded down to multiples of 200×100.
- **Canvas:** reads return per-session noised pixels.
- **WebGL:** vendor/renderer report a generic value.
- **Hardware:** `hardwareConcurrency` = 4, `deviceMemory` = 8.
- **Security levels** (like Tor Browser):
  - *Standard* — all of the above.
  - *Safer* — also disables WebGL, WebAssembly, and JIT-heavy features.
  - *Safest* — JavaScript off.

## Consequences
- + Removes the cheapest, most common fingerprinting vectors.
- − Not as strong as Tor Browser: few Veil users means a small crowd, and
  Chromium internals still differ. Documented in the video.
