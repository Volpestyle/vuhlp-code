# Dev setup (recommended)

## Tooling choice
- Use Expo dev client to support Skia and native modules.
- If you prefer React Native CLI, mirror the same dependencies and configs.

## Dependencies to add
- Core: `react`, `react-native`, `expo` (if using Expo)
- Rendering: `@shopify/react-native-skia`
- Gestures: `react-native-gesture-handler`
- Animations: `react-native-reanimated`
- State: `zustand` (or preferred state layer)
- Shared types: `@vuhlp/contracts`

## Configuration notes
- Reanimated: ensure the Babel plugin is configured.
- Gesture handler: register the root view wrapper.
- Skia: follow platform setup for iOS (pods) and Android (gradle).

## Suggested next steps
1. Bootstrap the app (Expo dev client recommended).
2. Wire `GraphStore`, `GraphViewport`, and `GraphController`.
3. Implement `GraphCanvas` edges + edge preview in Skia.
4. Port node cards into `GraphNodesOverlay` and align transforms.
5. Validate parity checklist and iterate.
