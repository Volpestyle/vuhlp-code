import { useRef, useEffect, useState, CSSProperties } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

type SpinnerSize = 'sm' | 'md' | 'lg';
type SpinnerVariant = 'globe' | 'tumble' | 'continuous';
type RenderMode = 'webgl' | 'ascii';

interface ThinkingSpinnerProps {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
  renderMode?: RenderMode;
  className?: string;
  color?: string;
  asciiResolution?: number;
}

const SIZE_MAP = {
  sm: 16,
  md: 24,
  lg: 32,
};

const ASCII_RAMP = ' .:-=+*#%@';

// Convert pixels to ASCII string
function pixelsToAscii(
  pixels: Uint8Array,
  width: number,
  height: number
): string {
  const ramp = ASCII_RAMP;
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

      // Perceived luminance (sRGB coefficients)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const idx = Math.min(rampLen, Math.floor((lum / 255) * rampLen));
      out += ramp[idx];
    }
    out += '\n';
  }
  return out;
}

// Animation state for globe variant
interface GlobeState {
  axis: 'Y' | 'X';
  phase: 'spinning' | 'stopped';
  spinStartTime: number;
  stoppedTime: number;
  startAngleY: number;
  startAngleX: number;
  currentY: number;
  currentX: number;
}

// Animation state for tumble variant
interface TumbleState {
  phase: 'spinY' | 'pauseY' | 'spinX' | 'pauseX';
  phaseStart: number;
  targetY: number;
  targetX: number;
  currentY: number;
  currentX: number;
  velY: number;
  velX: number;
}

// Ease in-out cubic
const easeInOut = (t: number): number => {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

interface AnimatedCubeProps {
  variant: SpinnerVariant;
  color: string;
}

function AnimatedCube({ variant, color }: AnimatedCubeProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const tiltRef = useRef<THREE.Group>(null);

  // Globe animation state
  const globeState = useRef<GlobeState>({
    axis: 'Y',
    phase: 'spinning',
    spinStartTime: 0,
    stoppedTime: 0,
    startAngleY: 0,
    startAngleX: 0,
    currentY: 0,
    currentX: 0,
  });

  // Tumble animation state
  const tumbleState = useRef<TumbleState>({
    phase: 'spinY',
    phaseStart: 0,
    targetY: Math.PI / 2,
    targetX: 0,
    currentY: 0,
    currentX: 0,
    velY: 0,
    velX: 0,
  });

  // Continuous animation state
  const continuousState = useRef({ rotation: 0 });

  useEffect(() => {
    // Reset states when variant changes
    globeState.current = {
      axis: 'Y',
      phase: 'spinning',
      spinStartTime: performance.now(),
      stoppedTime: 0,
      startAngleY: 0,
      startAngleX: 0,
      currentY: 0,
      currentX: 0,
    };
    tumbleState.current = {
      phase: 'spinY',
      phaseStart: performance.now(),
      targetY: Math.PI / 2,
      targetX: 0,
      currentY: 0,
      currentX: 0,
      velY: 0,
      velX: 0,
    };
    continuousState.current = { rotation: 0 };
  }, [variant]);

  useFrame(() => {
    if (!meshRef.current || !tiltRef.current) return;

    const now = performance.now();
    const time = now / 1000;

    // Breathing scale
    const breathScale = 1 + Math.sin(time * 0.8) * 0.03 + Math.sin(time * 1.7) * 0.015;
    meshRef.current.scale.setScalar(breathScale);

    if (variant === 'globe') {
      const state = globeState.current;
      const rotationsPerSpin = 3;
      const spinDuration = 1800;
      const pauseDuration = 400;

      // Tilt wobble
      const tiltAngle = (-20 + Math.sin(time * 0.6) * 3 + Math.sin(time * 1.1) * 2) * (Math.PI / 180);
      tiltRef.current.rotation.x = tiltAngle;

      if (state.phase === 'spinning') {
        const elapsed = now - state.spinStartTime;
        const progress = Math.min(elapsed / spinDuration, 1);
        const easedProgress = easeInOut(progress);

        const totalRotation = rotationsPerSpin * Math.PI * 2 + Math.PI / 2;

        if (state.axis === 'Y') {
          state.currentY = state.startAngleY + easedProgress * totalRotation;
          meshRef.current.rotation.y = state.currentY;
        } else {
          state.currentX = state.startAngleX + easedProgress * totalRotation;
          meshRef.current.rotation.x = state.currentX;
        }

        if (progress >= 1) {
          state.phase = 'stopped';
          state.stoppedTime = now;
        }
      } else if (state.phase === 'stopped') {
        if (now - state.stoppedTime >= pauseDuration) {
          if (state.axis === 'Y') {
            state.axis = 'X';
            state.startAngleX = state.currentX;
          } else {
            state.axis = 'Y';
            state.startAngleY = state.currentY;
          }
          state.spinStartTime = now;
          state.phase = 'spinning';
        }
      }
    } else if (variant === 'tumble') {
      const state = tumbleState.current;
      const spinDuration = 600;
      const pauseDuration = 200;
      const springSpeed = 0.08;
      const springDamping = 0.85;

      const elapsed = now - state.phaseStart;

      // Spring physics
      state.velY += (state.targetY - state.currentY) * springSpeed;
      state.velY *= springDamping;
      state.currentY += state.velY;

      state.velX += (state.targetX - state.currentX) * springSpeed;
      state.velX *= springDamping;
      state.currentX += state.velX;

      meshRef.current.rotation.y = state.currentY;
      meshRef.current.rotation.x = state.currentX;

      // No tilt for tumble
      tiltRef.current.rotation.x = 0;

      switch (state.phase) {
        case 'spinY':
          if (elapsed >= spinDuration) {
            state.targetY += Math.PI / 2;
            state.phase = 'pauseY';
            state.phaseStart = now;
          }
          break;
        case 'pauseY':
          if (elapsed >= pauseDuration) {
            state.phase = 'spinX';
            state.phaseStart = now;
          }
          break;
        case 'spinX':
          if (elapsed >= spinDuration) {
            state.targetX += Math.PI / 2;
            state.phase = 'pauseX';
            state.phaseStart = now;
          }
          break;
        case 'pauseX':
          if (elapsed >= pauseDuration) {
            state.phase = 'spinY';
            state.phaseStart = now;
          }
          break;
      }
    } else if (variant === 'continuous') {
      const state = continuousState.current;

      // Irregular rotation speed
      const speed = 0.008 + Math.sin(state.rotation * 3) * 0.004;
      state.rotation += speed;

      meshRef.current.rotation.y = state.rotation * Math.PI * 2;

      // Gentle tilt oscillation
      const tiltAngle = (-25 + Math.sin(state.rotation * Math.PI * 2) * 5) * (Math.PI / 180);
      tiltRef.current.rotation.x = tiltAngle;
    }
  });

  return (
    <group ref={tiltRef}>
      <mesh ref={meshRef}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          color={color}
          metalness={0.3}
          roughness={0.4}
        />
      </mesh>
      {/* Edges for better definition */}
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(1, 1, 1)]} />
        <lineBasicMaterial color={color} opacity={0.5} transparent />
      </lineSegments>
    </group>
  );
}

interface AsciiSamplerProps {
  cols: number;
  rows: number;
  fps: number;
  onAscii: (ascii: string) => void;
}

function AsciiSampler({ cols, rows, fps, onAscii }: AsciiSamplerProps) {
  const { gl, scene, camera } = useThree();
  const targetRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const pixelsRef = useRef<Uint8Array | null>(null);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    targetRef.current = new THREE.WebGLRenderTarget(cols, rows, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    pixelsRef.current = new Uint8Array(cols * rows * 4);

    return () => {
      targetRef.current?.dispose();
    };
  }, [cols, rows]);

  useFrame(() => {
    if (!targetRef.current || !pixelsRef.current) return;

    const now = performance.now();
    if (now - lastUpdateRef.current < 1000 / fps) return;

    // Render to target
    gl.setRenderTarget(targetRef.current);
    gl.render(scene, camera);
    gl.setRenderTarget(null);

    // Read pixels and convert to ASCII
    gl.readRenderTargetPixels(
      targetRef.current,
      0,
      0,
      cols,
      rows,
      pixelsRef.current
    );

    const ascii = pixelsToAscii(pixelsRef.current, cols, rows);
    onAscii(ascii);
    lastUpdateRef.current = now;
  });

  return null;
}

export function ThinkingSpinner({
  size = 'sm',
  variant = 'globe',
  renderMode = 'webgl',
  className = '',
  color,
  asciiResolution = 12,
}: ThinkingSpinnerProps) {
  const pixelSize = SIZE_MAP[size];
  const [ascii, setAscii] = useState('');

  // Inherit color from CSS currentColor or use provided color
  const cubeColor = color || 'currentColor';

  const containerStyle: CSSProperties = {
    width: pixelSize,
    height: pixelSize,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    verticalAlign: 'middle',
    position: 'relative',
  };

  const asciiStyle: CSSProperties = {
    fontFamily: 'monospace',
    fontSize: `${pixelSize / asciiResolution}px`,
    lineHeight: 1,
    whiteSpace: 'pre',
    color: 'currentColor',
    letterSpacing: '-0.05em',
  };

  if (renderMode === 'ascii') {
    return (
      <span
        className={`thinking-spinner thinking-spinner--${size} ${className}`}
        role="status"
        aria-label="loading"
        style={containerStyle}
      >
        <Canvas
          style={{
            position: 'absolute',
            width: '100%',
            height: '100%',
            opacity: 0,
            pointerEvents: 'none',
          }}
          camera={{ position: [0, 0, 2.5], fov: 50 }}
          gl={{ preserveDrawingBuffer: true }}
        >
          <ambientLight intensity={0.4} />
          <directionalLight position={[3, 3, 5]} intensity={0.8} />
          <directionalLight position={[-2, -2, -3]} intensity={0.3} />
          <AnimatedCube variant={variant} color="#ffffff" />
          <AsciiSampler
            cols={asciiResolution}
            rows={asciiResolution}
            fps={15}
            onAscii={setAscii}
          />
        </Canvas>
        <span style={asciiStyle}>{ascii}</span>
      </span>
    );
  }

  return (
    <span
      className={`thinking-spinner thinking-spinner--${size} ${className}`}
      role="status"
      aria-label="loading"
      style={containerStyle}
    >
      <Canvas
        style={{ width: '100%', height: '100%' }}
        camera={{ position: [0, 0, 2.5], fov: 50 }}
      >
        <ambientLight intensity={0.4} />
        <directionalLight position={[3, 3, 5]} intensity={0.8} />
        <directionalLight position={[-2, -2, -3]} intensity={0.3} />
        <AnimatedCube variant={variant} color={cubeColor} />
      </Canvas>
    </span>
  );
}
