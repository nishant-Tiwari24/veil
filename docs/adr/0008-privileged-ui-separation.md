# ADR 0008 — Privileged UI is separated from web content

**Status:** Accepted

## Context
If a web page could reach the browser's own controls, it could ask for
circuit info, invites or the real network.

## Decision
- The toolbar/UI is its own `WebContentsView` with a preload exposing a
  minimal IPC API. Web tabs get **no** IPC API, `sandbox: true`,
  `nodeIntegration: false`.
- Internal pages (`veil://hub`, `veil://leaktest`) are served by a custom
  protocol from the app bundle — no network involved.
- IPC handlers check the sender is the UI view.

## Consequences
- + A malicious page can't drive Veil.
