# @vuhlp/mobile

Mobile companion app for the Vuhlp agent orchestration platform.

## Tech Stack

- **Expo** (SDK 54) with dev client
- **React Native** 0.81
- **React** 19.1
- **@shopify/react-native-skia** for graph rendering
- **react-native-gesture-handler** for touch interactions
- **react-native-reanimated** for smooth animations
- **zustand** for state management
- **@vuhlp/contracts** for shared types

## Setup

### Prerequisites

- Node.js 25+
- pnpm 9+
- Xcode 16+ (for iOS)
- iOS 17+ device or simulator

### Install

From the monorepo root:

```bash
pnpm install
```

### Configure API URL

Copy `.env.example` to `.env` and set your daemon's IP address:

```bash
cd packages/mobile
cp .env.example .env
```

Edit `.env` to point to your daemon:

```
EXPO_PUBLIC_API_URL=http://your-machine-ip:4000
```

> **Note:** Use your machine's local IP address, not `localhost`, for device testing.

### Run on Device

Build the dev client and run on a connected device (update the device ID in `package.json` if needed):

```bash
cd packages/mobile
pnpm prebuild
pnpm ios
```

For development with hot reload:

```bash
pnpm dev
```

Then scan the QR code with the Expo Go app (limited features) or the dev client.

## Project Structure

```
packages/mobile/
├── app/                    # Expo Router screens
│   ├── _layout.tsx        # Root layout with gesture handler
│   ├── index.tsx          # Runs list screen
│   └── run/[id].tsx       # Graph view screen
├── src/
│   ├── components/        # UI components
│   │   ├── GraphCanvas.tsx   # Skia edges + gestures
│   │   ├── GraphMinimap.tsx  # Minimap navigation
│   │   ├── NodeCard.tsx      # Draggable node card + ports
│   │   ├── NodeInspector.tsx # Bottom sheet inspector
│   │   └── ApprovalQueue.tsx # Pending approvals
│   ├── stores/            # Zustand stores
│   │   └── graph-store.ts    # Graph + UI state
│   └── lib/               # Utilities
│       ├── api.ts            # REST API client
│       ├── useRunConnection.ts # WebSocket hook
│       └── useLayoutPersistence.ts # Layout save
├── assets/                # App icons and images
├── docs/                  # Architecture documentation
└── app.json              # Expo configuration
```

## Features

### Current
- [x] Run list + run screen
- [x] WebSocket event stream + REST hydration
- [x] Skia edge rendering + handoff animations
- [x] Node cards with drag + selection + port handles
- [x] Edge creation with snap radius
- [x] Minimap navigation
- [x] Node inspector (chat + tool timeline)
- [x] Approval queue actions
- [x] Layout persistence back to the daemon

### Planned
- [ ] Edge selection + deletion
- [ ] Multi-select + box select
- [ ] Node actions (duplicate, delete)
- [ ] Visual parity with web UI

## Architecture

See [docs/](./docs/) for detailed architecture documentation:

- [01-scope.md](./docs/01-scope.md) - Project scope and goals
- [02-architecture.md](./docs/02-architecture.md) - System architecture
- [03-gestures.md](./docs/03-gestures.md) - Gesture handling design
- [04-rendering.md](./docs/04-rendering.md) - Skia rendering approach
- [05-parity-checklist.md](./docs/05-parity-checklist.md) - Feature parity with web
- [06-dev-setup.md](./docs/06-dev-setup.md) - Development setup guide
