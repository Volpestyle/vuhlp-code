# @vuhlp/mobile

Mobile companion app for the Vuhlp agent orchestration platform.

## Tech Stack

- **Expo** (SDK 52) with dev client
- **React Native** 0.76
- **@shopify/react-native-skia** for graph edge rendering
- **react-native-gesture-handler** for touch interactions
- **react-native-reanimated** for smooth animations
- **zustand** for state management
- **@vuhlp/contracts** for shared types

## Setup

### Prerequisites

- Node.js 20+
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
EXPO_PUBLIC_API_URL=http://192.168.1.100:4000
```

> **Note:** Use your machine's local IP address, not `localhost`, for device testing.

### Run on Device

Build the dev client and run on a connected device:

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
│   │   ├── GraphCanvas.tsx   # Skia-based graph renderer
│   │   └── NodeCard.tsx      # Draggable node card
│   ├── stores/            # Zustand stores
│   │   └── graph-store.ts    # Graph state management
│   └── lib/               # Utilities
│       ├── api.ts            # REST API client
│       └── useRunConnection.ts # WebSocket hook
├── assets/                # App icons and images
├── docs/                  # Architecture documentation
└── app.json              # Expo configuration
```

## Features

### Phase 1 (Current)
- [x] Expo project setup
- [x] GraphStore with Zustand
- [x] API client for daemon
- [x] WebSocket real-time events
- [x] Basic graph rendering with Skia
- [x] Node cards with drag support
- [x] Pan and pinch zoom gestures

### Phase 2 (Planned)
- [ ] Edge creation via port drag
- [ ] Node selection and inspector
- [ ] Chat interface per node
- [ ] Approval queue UI

### Phase 3 (Planned)
- [ ] Visual parity with web UI
- [ ] Performance optimization
- [ ] Dark/light theme support

## Architecture

See [docs/](./docs/) for detailed architecture documentation:

- [01-scope.md](./docs/01-scope.md) - Project scope and goals
- [02-architecture.md](./docs/02-architecture.md) - System architecture
- [03-gestures.md](./docs/03-gestures.md) - Gesture handling design
- [04-rendering.md](./docs/04-rendering.md) - Skia rendering approach
- [05-parity-checklist.md](./docs/05-parity-checklist.md) - Feature parity with web
- [06-dev-setup.md](./docs/06-dev-setup.md) - Development setup guide
