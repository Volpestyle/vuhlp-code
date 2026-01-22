# Rendering and performance

## Skia layers (current)
- Edge paths (cubic Bezier + arrowheads)
- Edge preview line during drag
- Handoff packet animations (glow + core circles)
- Minimap uses a separate Skia canvas

## Edge geometry
- Ports are derived from node bounds (top/right/bottom/left).
- The shortest port pair determines the curve.
- Control points offset by distance (clamped to 150) to match web.
- Paths are recalculated on the UI thread using shared node positions.

## Animation
- Viewport transforms live in Reanimated shared values and are applied to a Skia matrix.
- Handoff packets animate via `useFrameCallback` while active.

## Fallback behavior
- If Skia fails to initialize (e.g., no dev client), the canvas shows a fallback message.

## Performance notes
- No edge culling yet; keep graphs moderate on mobile.
