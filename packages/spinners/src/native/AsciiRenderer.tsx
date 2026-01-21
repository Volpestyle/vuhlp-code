/**
 * AsciiRenderer - Core ASCII rendering component
 * Converts a 3D scene to ASCII art text
 * Per docs/3d_ascii.md implementation guide
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type ViewStyle, Animated } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Canvas, useFrame, useThree } from '@react-three/fiber/native';
import * as THREE from 'three';

// Removed internal import, using props or defaults for color if needed, 
// ensuring standalone behavior. Colors can be passed in from consumer.

/**
 * Context for sharing pointer/touch state from React Native to the 3D scene.
 * This is needed because on iOS, the hidden Canvas doesn't receive touch events.
 */
export interface PointerState {
  isActive: boolean;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  shouldReset: boolean;
}

export const PointerContext = createContext<React.RefObject<PointerState> | null>(null);

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

interface AsciiRendererProps {
  /** Number of columns (characters) */
  cols?: number;
  /** Number of rows */
  rows?: number;
  /** Target FPS for ASCII updates */
  fps?: number;
  /** Invert brightness mapping */
  invert?: boolean;
  /** Text color */
  color?: string;
  /** Container size - used to calculate font scaling */
  containerSize?: number;
  /** Additional style */
  style?: ViewStyle;
  /** 3D scene to render (children of Canvas) */
  children: React.ReactNode;
  /** Notify when first ASCII frame is ready */
  onReady?: () => void;
}

/**
 * Convert pixel buffer to ASCII string
 */
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
      const r = pixels[i] || 0;
      const g = pixels[i + 1] || 0;
      const b = pixels[i + 2] || 0;

      // Perceived luminance (rough sRGB)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const idx = Math.min(rampLen, Math.floor((lum / 255) * rampLen));
      out += ramp[idx];
    }
    out += '\n';
  }
  return out;
}

/**
 * Component that samples the render target and outputs ASCII
 */
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
const CHAR_ASPECT_RATIO = 0.6;

export function AsciiRenderer({
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  fps = DEFAULT_FPS,
  invert = true,
  color = '#ffffff', // Default color, removed import
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
  
  // Create shared value for bounce animation
  const scale = React.useRef(new Animated.Value(1)).current;

  useEffect(() => {
    setCurrentColor(color);
  }, [color]);

  useEffect(() => {
    if (isBouncing) {
        Animated.sequence([
            Animated.timing(scale, {
                toValue: 0.95,
                duration: 100,
                useNativeDriver: true,
            }),
            Animated.timing(scale, {
                toValue: 1,
                duration: 100,
                useNativeDriver: true,
            }),
        ]).start(() => setIsBouncing(false));
    }
  }, [isBouncing, scale]);

  // Pointer state shared with 3D scene via context
  const pointerStateRef = useRef<PointerState>({
    isActive: false,
    x: 0,
    y: 0,
    deltaX: 0,
    deltaY: 0,
    shouldReset: false,
  });

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

  // Pan gesture for trackball interaction
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        // Force JS thread callbacks so we can mutate React refs for R3F.
        // Without this, native UI-thread worklets won't update JS state on iOS.
        .runOnJS(true)
        .onStart((e) => {
          pointerStateRef.current.isActive = true;
          pointerStateRef.current.x = e.x;
          pointerStateRef.current.y = e.y;
          pointerStateRef.current.deltaX = 0;
          pointerStateRef.current.deltaY = 0;
        })
        .onUpdate((e) => {
          pointerStateRef.current.deltaX = e.x - pointerStateRef.current.x;
          pointerStateRef.current.deltaY = e.y - pointerStateRef.current.y;
          pointerStateRef.current.x = e.x;
          pointerStateRef.current.y = e.y;
        })
        .onEnd(() => {
            pointerStateRef.current.isActive = false;
        }),
    []
  );

  const tapGesture = useMemo(
      () =>
        Gesture.Tap()
          .runOnJS(true)
          .onEnd(() => {
             // Only trigger tap if not resetting
             if (!pointerStateRef.current.shouldReset) {
               setIsBouncing(true);
               setCurrentColor(prev => {
                  const idx = INTERACTIVE_COLORS.indexOf(prev || '');
                  const nextIdx = (idx + 1) % INTERACTIVE_COLORS.length;
                  return INTERACTIVE_COLORS[nextIdx] || INTERACTIVE_COLORS[0] || '#ffffff';
                });
              }
          }),
      []
    );

  const longPressGesture = useMemo(
      () =>
        Gesture.LongPress()
          .runOnJS(true)
          .minDuration(500)
          .onStart(() => {
             pointerStateRef.current.shouldReset = true;
          }),
          // Don't clear on finalize - let the 3D scene clear it when animation completes
      []
  );

  const composedGesture = useMemo(() => Gesture.Race(panGesture, tapGesture, longPressGesture), [panGesture, tapGesture, longPressGesture]);

  // Calculate font size to fit container
  // If containerSize is provided, scale to fit; otherwise use default
  const fontSize = useMemo(() => {
    if (!containerSize) return 5;

    // Calculate font size that fits the container
    // Width constraint: cols * (fontSize * CHAR_ASPECT_RATIO) <= containerSize
    // Height constraint: rows * fontSize <= containerSize
    const fontSizeByWidth = containerSize / (cols * CHAR_ASPECT_RATIO);
    const fontSizeByHeight = containerSize / rows;

    // Use the smaller to ensure it fits both dimensions
    return Math.min(fontSizeByWidth, fontSizeByHeight);
  }, [containerSize, cols, rows]);

  const lineHeight = fontSize;

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View style={[styles.container, style, { transform: [{ scale: scale }] }]}>
        {/* Hidden canvas for 3D rendering */}
        <PointerContext.Provider value={pointerStateRef}>
          <Canvas style={styles.hiddenCanvas} frameloop="always">
            {/* Dark background so empty areas render as dark ASCII */}
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
        </PointerContext.Provider>

        {/* ASCII text overlay */}
        <View style={styles.asciiLayer} pointerEvents="none">
          <Text
            style={[
              styles.asciiText,
              {
                color: currentColor,
                fontSize,
                lineHeight,
              },
            ]}
          >
            {ascii}
          </Text>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  hiddenCanvas: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0, // Hide the actual 3D render
  },
  asciiLayer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  asciiText: {
    includeFontPadding: false,
    // Use Space Mono or similar monospace font available in the app.
    // 'SpaceMono-Regular' is standard in Expo templates.
    fontFamily: 'SpaceMono-Regular', 
  },
});
