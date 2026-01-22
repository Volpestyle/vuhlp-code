# Dev setup (recommended)

## Tooling choice
- Use Expo dev client to support Skia and native modules.
- React Native CLI is possible, but the repo is tuned for Expo.

## Current dependencies
- Core: `react`, `react-native`, `expo`
- Rendering: `@shopify/react-native-skia`
- Gestures: `react-native-gesture-handler`
- Animations: `react-native-reanimated`
- State: `zustand`
- Shared types: `@vuhlp/contracts`

## Configuration notes
- Reanimated: ensure the Babel plugin is configured.
- Gesture handler: register the root view wrapper.
- Skia: follow platform setup for iOS (pods) and Android (gradle).

## Suggested next steps
1. Keep parity checklist up to date.
2. Fill gaps (edge selection, node actions, run controls).
3. Add perf checks as node counts grow.
