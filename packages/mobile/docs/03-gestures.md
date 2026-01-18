# Gestures and interaction

## Gesture mapping
- Pan viewport: one-finger pan gesture on the canvas background.
- Zoom: pinch gesture, centered on pinch focal point.
- Node drag: pan gesture on node cards.
- Edge creation: pan gesture on ports, updates edge preview.
- Tap select: tap gesture on nodes/edges/background.

## Conflict rules
- Port drag has priority over node drag.
- Node drag has priority over viewport pan.
- Pinch zoom disables pan during active pinch.
- Tapping while dragging does nothing (avoid accidental selection).

## Implementation notes
- Use `react-native-gesture-handler` with simultaneous gesture support.
- Drive viewport transforms with Reanimated shared values.
- Keep JS hit testing minimal; prefer cached bounds for nodes and ports.
