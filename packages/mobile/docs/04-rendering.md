# Rendering and performance

## Skia layers
- Layer 1: edges (static)
- Layer 2: edge preview (transient)
- Layer 3: selection outlines and hover states

## Path building
- Use cubic Bezier paths to match web visuals.
- Cache path strings for stable edges; rebuild only on node movement.
- Keep edge preview in a separate path with distinct style.

## Culling
- Skip edges where both endpoints are outside the viewport bounds.
- Clip the canvas to viewport size to avoid overdraw.

## Animation
- Use Reanimated derived values for viewport transforms.
- Keep animations UI-thread friendly; avoid per-frame JS work.
