# Scope and goals

## Goals
- Full editing parity with the web graph UI (nodes, edges, gestures, selection).
- iOS and Android support with a native-feeling interaction model.
- Online-first, no offline requirements.
- Skia-based rendering for edges, previews, and selection visuals.

## Non-goals (for now)
- WebView fallback.
- Desktop support.
- Offline-first data model or local sync.

## Assumptions
- The mobile app can reuse existing contracts from `@vuhlp/contracts`.
- Graph nodes remain React Native views; only the canvas layer is reimplemented.
- The app is small enough to focus on parity before optimizations beyond culling.
