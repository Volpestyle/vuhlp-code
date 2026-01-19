import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

// Pointer state shared with 3D scene via context
export interface PointerState {
  isActive: boolean;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  shouldReset: boolean;
}

export const PointerContext = createContext<RefObject<PointerState | null> | null>(null);

export function usePointerContext() {
  return useContext(PointerContext);
}

// ASCII character ramp from light to dark
const ASCII_RAMP = ' .:-=+*#%@';

const INTERACTIVE_COLORS = [
  '#ffffff', // White
  '#4ade80', // Green
  '#60a5fa', // Blue
  '#f472b6', // Pink
  '#fbbf24', // Amber
  '#a78bfa', // Purple
];

// Default rendering settings
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 50;
const DEFAULT_FPS = 12;

export interface AsciiRendererProps {
  cols?: number;
  rows?: number;
  fps?: number;
  invert?: boolean;
  color?: string;
  containerSize?: number;
  style?: CSSProperties;
  children: ReactNode;
  onReady?: () => void;
}

function pixelsToAscii(
  pixels: Uint8Array,
  width: number,
  height: number,
  invert: boolean
): string {
  const ramp = invert ? ASCII_RAMP.split('').reverse().join('') : ASCII_RAMP;
  const rampLen = ramp.length - 1;

  let out = '';
  // WebGL (0,0) is bottom-left; flip vertically
  for (let y = height - 1; y >= 0; y--) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowOffset + x * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];

      // Perceived luminance (rough sRGB)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const idx = Math.min(rampLen, Math.floor((lum / 255) * rampLen));
      out += ramp[idx];
    }
    out += '\n';
  }
  return out;
}

function AsciiSampler({
  cols,
  rows,
  fps,
  invert,
  onAscii,
}: {
  cols: number;
  rows: number;
  fps: number;
  invert: boolean;
  onAscii: (value: string) => void;
}) {
  const { gl, scene, camera } = useThree();
  const target = useMemo(() => new THREE.WebGLRenderTarget(cols, rows), [cols, rows]);
  const pixels = useMemo(() => new Uint8Array(cols * rows * 4), [cols, rows]);
  const lastAsciiAt = useRef(0);

  useEffect(() => {
    return () => target.dispose();
  }, [target]);

  useFrame((state) => {
    const t = state.clock.elapsedTime * 1000;

    // Render into the tiny render target
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(null);

    // Update ASCII at lower FPS
    if (t - lastAsciiAt.current >= 1000 / fps) {
      gl.readRenderTargetPixels(target, 0, 0, cols, rows, pixels);
      onAscii(pixelsToAscii(pixels, cols, rows, invert));
      lastAsciiAt.current = t;
    }
  });

  return null;
}

// Approximate character aspect ratio for monospace fonts (width/height)
const CHAR_ASPECT_RATIO = 0.55;

export function AsciiRenderer({
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  fps = DEFAULT_FPS,
  invert = true,
  color = '#ffffff',
  containerSize,
  style,
  children,
  onReady,
}: AsciiRendererProps) {
  const [ascii, setAscii] = useState('Loading...\n');
  const readyRef = useRef(false);

  // Interactive state
  const [currentColor, setCurrentColor] = useState(color);
  const [isBouncing, setIsBouncing] = useState(false);
  const clickStartRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    setCurrentColor(color);
  }, [color]);

  // Pointer state shared with 3D scene via context
  const pointerStateRef = useRef<PointerState>({
    isActive: false,
    x: 0,
    y: 0,
    deltaX: 0,
    deltaY: 0,
    shouldReset: false,
  });

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAscii = useCallback(
    (value: string) => {
      if (!readyRef.current) {
        readyRef.current = true;
        onReady?.();
      }
      setAscii(value);
    },
    [onReady]
  );

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStateRef.current.isActive = true;
    pointerStateRef.current.x = event.clientX;
    pointerStateRef.current.y = event.clientY;
    pointerStateRef.current.deltaX = 0;
    pointerStateRef.current.deltaY = 0;

    clickStartRef.current = { x: event.clientX, y: event.clientY };

    // Start long press timer
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      pointerStateRef.current.shouldReset = true;
    }, 500); // 500ms for long press
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // If moved significantly, cancel long press
    if (Math.hypot(event.clientX - clickStartRef.current.x, event.clientY - clickStartRef.current.y) > 10) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }

    if (pointerStateRef.current.isActive) {
      pointerStateRef.current.deltaX = event.clientX - pointerStateRef.current.x;
      pointerStateRef.current.deltaY = event.clientY - pointerStateRef.current.y;
      pointerStateRef.current.x = event.clientX;
      pointerStateRef.current.y = event.clientY;
    }
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    pointerStateRef.current.isActive = false;
    // Don't reset shouldReset here - let the 3D scene clear it when animation completes

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // Handle click interaction (bounce + color cycle) - only if not resetting
    if (!pointerStateRef.current.shouldReset) {
      const dist = Math.hypot(event.clientX - clickStartRef.current.x, event.clientY - clickStartRef.current.y);
      if (dist < 5) {
        setIsBouncing(true);
        setTimeout(() => setIsBouncing(false), 200);

        setCurrentColor((prev) => {
          const idx = INTERACTIVE_COLORS.indexOf(prev);
          const nextIdx = (idx + 1) % INTERACTIVE_COLORS.length;
          return idx === -1 ? INTERACTIVE_COLORS[0] : INTERACTIVE_COLORS[nextIdx];
        });
      }
    }
  }, []);

  const fontSize = useMemo(() => {
    if (!containerSize) return 5;
    const fontSizeByWidth = containerSize / (cols * CHAR_ASPECT_RATIO);
    const fontSizeByHeight = containerSize / rows;
    return Math.min(fontSizeByWidth, fontSizeByHeight);
  }, [containerSize, cols, rows]);

  const lineHeight = fontSize;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: 'transparent',
        position: 'relative',
        cursor: 'grab',
        touchAction: 'none',
        transition: 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
        transform: isBouncing ? 'scale(0.95)' : 'scale(1)',
        ...style,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <PointerContext.Provider value={pointerStateRef}>
        <div style={{ position: 'absolute', width: '100%', height: '100%', opacity: 0, pointerEvents: 'none' }}>
          <Canvas frameloop="always">
            <color attach="background" args={['#000000']} />
            {children}
            <AsciiSampler
              cols={cols}
              rows={rows}
              fps={fps}
              invert={invert}
              onAscii={handleAscii}
            />
          </Canvas>
        </div>
      </PointerContext.Provider>

      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        userSelect: 'none',
      }}>
        <pre
          style={{
            margin: 0,
            padding: 0,
            color: currentColor,
            fontSize: `${fontSize}px`,
            lineHeight: `${lineHeight}px`,
            fontFamily: 'monospace',
            whiteSpace: 'pre',
          }}
        >
          {ascii}
        </pre>
      </div>
    </div>
  );
}
