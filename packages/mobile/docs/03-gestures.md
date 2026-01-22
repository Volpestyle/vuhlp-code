# Gestures and interaction

## Gesture mapping (current)
- Pan viewport: one-finger pan on the canvas background.
- Zoom: pinch gesture, centered on the pinch focal point.
- Fit view: double tap on the canvas background.
- Node drag: pan gesture on node cards.
- Edge creation: drag from a node port; snaps when near another node port.
- Tap select: tap node to select; tap empty canvas to clear selection.
- Minimap: tap or drag to re-center the viewport.

## Conflict rules
- Pinch and pan are simultaneous for two-finger navigation.
- Pan is exclusive with tap to avoid accidental selections while dragging.
- Node drag fails immediately when a touch starts on a port hit zone.
- Tap handlers bail out while panning or pinching.

## Implementation notes
- `GraphCanvas` owns the canvas-level gestures and viewport shared values.
- `NodeCard` handles drag/tap and delegates port drag to the canvas.
- Edge snapping uses a fixed radius in world-space.
