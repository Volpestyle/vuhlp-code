import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { AsciiRenderer, usePointerContext } from './AsciiRenderer';

const TRACKBALL_SENSITIVITY = 0.008;
const MOMENTUM_FRICTION = 0.95;
const VELOCITY_THRESHOLD = 0.0001;

export type ShapeType = 'torusKnot' | 'heart' | 'cube';

export interface AsciiSpinnerProps {
  size?: number;
  resolution?: 'low' | 'medium' | 'high';
  color?: string;
  cycle?: boolean;
  cycleDuration?: number;
  shapes?: ShapeType[];
  shape?: ShapeType;
  style?: CSSProperties;
  onReady?: () => void;
  // New props for external models
  modelUrl?: string;
  customScene?: ReactNode;
}

const resolutionSettings = {
  low: { cols: 60, rows: 30, fps: 10 },
  medium: { cols: 80, rows: 40, fps: 12 },
  high: { cols: 100, rows: 50, fps: 15 },
};

const DEFAULT_CAMERA_POSITION: [number, number, number] = [0, 0, 1.8];

export function SceneCamera({
  fov = 40,
  position = DEFAULT_CAMERA_POSITION,
}: {
  fov?: number;
  position?: [number, number, number];
}) {
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const set = useThree((state) => state.set);

  useEffect(() => {
    if (cameraRef.current) {
      set({ camera: cameraRef.current });
    }
  }, [set]);

  return <perspectiveCamera ref={cameraRef} fov={fov} position={position} />;
}

export function useTrackball() {
  const pointerContext = usePointerContext();
  const userRotation = useRef(new THREE.Quaternion());
  const velocity = useRef({ x: 0, y: 0 });
  const wasActive = useRef(false);
  const lastUpdateTime = useRef(0);

  const update = useCallback(() => {
    const now = performance.now();
    const dt = Math.max(1, now - lastUpdateTime.current);
    lastUpdateTime.current = now;

    if (pointerContext?.current) {
      const { isActive, deltaX, deltaY, shouldReset } = pointerContext.current;

      if (shouldReset) {
        // Animate back to identity with faster interpolation
        const identity = new THREE.Quaternion();
        userRotation.current.slerp(identity, 0.15);
        velocity.current = { x: 0, y: 0 }; // Kill velocity

        // Check if we're close enough to identity to stop
        if (userRotation.current.angleTo(identity) < 0.01) {
          userRotation.current.identity();
          pointerContext.current.shouldReset = false;
        }
        return; // Skip other logic during reset
      }

      if (isActive) {
        if (deltaX !== 0 || deltaY !== 0) {
          velocity.current = {
            x: deltaX / dt,
            y: deltaY / dt,
          };

          const deltaQuat = new THREE.Quaternion();
          deltaQuat.setFromEuler(
            new THREE.Euler(
              deltaY * TRACKBALL_SENSITIVITY,
              deltaX * TRACKBALL_SENSITIVITY,
              0,
              'XYZ'
            )
          );
          userRotation.current.premultiply(deltaQuat);

          pointerContext.current.deltaX = 0;
          pointerContext.current.deltaY = 0;
        }
        wasActive.current = true;
      } else if (wasActive.current) {
        wasActive.current = false;
      }
    }

    if (!pointerContext?.current?.isActive && !pointerContext?.current?.shouldReset) {
      const vx = velocity.current.x;
      const vy = velocity.current.y;

      if (Math.abs(vx) >= VELOCITY_THRESHOLD || Math.abs(vy) >= VELOCITY_THRESHOLD) {
        const deltaQuat = new THREE.Quaternion();
        deltaQuat.setFromEuler(
          new THREE.Euler(
            vy * TRACKBALL_SENSITIVITY * 16,
            vx * TRACKBALL_SENSITIVITY * 16,
            0,
            'XYZ'
          )
        );
        userRotation.current.premultiply(deltaQuat);

        velocity.current.x *= MOMENTUM_FRICTION;
        velocity.current.y *= MOMENTUM_FRICTION;
      }
    }
  }, [pointerContext]);

  return {
    userRotation,
    update,
  };
}

// Scene wrapper that handles rotation for any content
function AutoRotateScene({ children, speed = 1.0 }: { children: ReactNode; speed?: number }) {
  const groupRef = useRef<THREE.Group>(null);
  const autoRotation = useRef(new THREE.Quaternion());
  const { userRotation, update } = useTrackball();

  useFrame((state) => {
    update();
    const t = state.clock.elapsedTime;
    if (groupRef.current) {
      autoRotation.current.setFromEuler(
        new THREE.Euler(t * 0.4 * speed, t * 0.6 * speed, 0, 'XYZ')
      );
      groupRef.current.quaternion.copy(userRotation.current).multiply(autoRotation.current);
    }
  });

  return (
    <group ref={groupRef}>
      {children}
    </group>
  );
}

function SpinnerScene() {
  return (
    <>
      <SceneCamera />
      <ambientLight intensity={0.45} />
      <hemisphereLight args={['#ffffff', '#222222', 0.35]} />
      <directionalLight position={[3, 3, 5]} intensity={0.8} />
      <directionalLight position={[-2, -2, -3]} intensity={0.3} />

      <AutoRotateScene>
        <mesh>
          <torusKnotGeometry args={[0.42, 0.13, 64, 16]} />
          <meshStandardMaterial
            color="#ffffff"
            roughness={0.5}
            metalness={0.2}
          />
        </mesh>
        <lineSegments>
          <edgesGeometry
            args={[new THREE.TorusKnotGeometry(0.42, 0.13, 64, 16)]}
          />
          <lineBasicMaterial color="#ffffff" transparent opacity={0.3} />
        </lineSegments>
      </AutoRotateScene>
    </>
  );
}

function createHeartGeometry(): THREE.ExtrudeGeometry {
  const heartShape = new THREE.Shape();
  const s = 0.06;
  heartShape.moveTo(5 * s, 5 * s);
  heartShape.bezierCurveTo(5 * s, 5 * s, 4 * s, 0, 0, 0);
  heartShape.bezierCurveTo(-6 * s, 0, -6 * s, 7 * s, -6 * s, 7 * s);
  heartShape.bezierCurveTo(-6 * s, 11 * s, -3 * s, 15.4 * s, 5 * s, 19 * s);
  heartShape.bezierCurveTo(12 * s, 15.4 * s, 16 * s, 11 * s, 16 * s, 7 * s);
  heartShape.bezierCurveTo(16 * s, 7 * s, 16 * s, 0, 10 * s, 0);
  heartShape.bezierCurveTo(7 * s, 0, 5 * s, 5 * s, 5 * s, 5 * s);

  const extrudeSettings = {
    depth: 0.25,
    bevelEnabled: true,
    bevelSegments: 3,
    steps: 1,
    bevelSize: 0.05,
    bevelThickness: 0.05,
  };

  const geometry = new THREE.ExtrudeGeometry(heartShape, extrudeSettings);
  geometry.center();
  geometry.rotateZ(Math.PI);
  return geometry;
}

function HeartScene() {
  const groupRef = useRef<THREE.Group>(null);
  const heartGeometry = useMemo(() => createHeartGeometry(), []);
  const autoRotation = useRef(new THREE.Quaternion());
  const { userRotation, update } = useTrackball();

  useFrame((state) => {
    update();
    const t = state.clock.elapsedTime;
    if (groupRef.current) {
      // Y-axis only rotation to keep heart upright
      autoRotation.current.setFromEuler(
        new THREE.Euler(0, t * 0.5, 0, 'XYZ')
      );
      groupRef.current.quaternion.copy(userRotation.current).multiply(autoRotation.current);
    }
  });

  return (
    <>
      <SceneCamera position={[0, 0, 2.1]} />
      <ambientLight intensity={0.5} />
      <hemisphereLight args={['#ffffff', '#222222', 0.45]} />
      <directionalLight position={[3, 3, 5]} intensity={0.8} />
      <directionalLight position={[-2, -2, -3]} intensity={0.35} />

      <group ref={groupRef}>
        <mesh geometry={heartGeometry}>
          <meshStandardMaterial
            color="#ffffff"
            roughness={0.5}
            metalness={0.2}
            side={THREE.DoubleSide}
          />
        </mesh>
        <lineSegments>
          <edgesGeometry args={[heartGeometry]} />
          <lineBasicMaterial color="#ffffff" transparent opacity={0.3} />
        </lineSegments>
      </group>
    </>
  );
}

function CubeScene() {
  return (
    <>
      <SceneCamera />
      <ambientLight intensity={0.5} />
      <directionalLight position={[2, 3, 4]} intensity={0.8} />

      <AutoRotateScene speed={1.2}>
        <mesh>
          <boxGeometry args={[0.9, 0.9, 0.9]} />
          <meshStandardMaterial color="#ffffff" roughness={0.4} />
        </mesh>
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(0.9, 0.9, 0.9)]} />
          <lineBasicMaterial color="#ffffff" transparent opacity={0.3} />
        </lineSegments>
      </AutoRotateScene>
    </>
  );
}

const isMesh = (object: THREE.Object3D): object is THREE.Mesh => object instanceof THREE.Mesh;

function ModelScene({ url }: { url: string }) {
  const gltf = useGLTF(url);
  const scene = useMemo(() => {
    const s = gltf.scene.clone(true);
    // Center and scale to fit unit sphere
    const box = new THREE.Box3().setFromObject(s);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    s.position.x = -center.x;
    s.position.y = -center.y;
    s.position.z = -center.z;
    s.scale.setScalar(1.5 / maxDim);

    // Add wireframe to meshes
    s.traverse((child) => {
      if (!isMesh(child)) return;
      child.material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.5,
        metalness: 0.2,
      });
      // Create wireframe as a separate child
      const edges = new THREE.EdgesGeometry(child.geometry);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 })
      );
      child.add(line);
    });
    return s;
  }, [gltf]);

  return (
    <>
      <SceneCamera />
      <ambientLight intensity={0.5} />
      <directionalLight position={[2, 3, 4]} intensity={0.8} />
      <directionalLight position={[-2, -2, -3]} intensity={0.4} />
      <AutoRotateScene>
        <primitive object={scene} />
      </AutoRotateScene>
    </>
  );
}

const shapeScenes: Record<ShapeType, ComponentType> = {
  torusKnot: SpinnerScene,
  heart: HeartScene,
  cube: CubeScene,
};

const DEFAULT_SHAPES: ShapeType[] = ['cube', 'heart', 'torusKnot'];
const DEFAULT_CYCLE_DURATION = 15000;
const TRANSITION_DURATION = 800;

export function AsciiSpinner({
  size = 400,
  resolution = 'medium',
  color = '#4ade80',
  cycle = true,
  cycleDuration = DEFAULT_CYCLE_DURATION,
  shapes = DEFAULT_SHAPES,
  shape,
  style,
  onReady,
  modelUrl,
  customScene,
}: AsciiSpinnerProps) {
  const settings = resolutionSettings[resolution];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [opacity, setOpacity] = useState(1);

  // If a single shape is provided via `shape` prop, use it exclusively.
  const activeShapes = useMemo(() => {
    return shape ? [shape] : shapes;
  }, [shape, shapes]);

  useEffect(() => {
    // If shape is provided (length 1), or activeShapes length is 1, don't cycle
    if (!cycle || activeShapes.length <= 1 || modelUrl || customScene) return;

    const interval = setInterval(() => {
      setOpacity(0);
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % activeShapes.length);
        setOpacity(1);
      }, TRANSITION_DURATION / 2);
    }, cycleDuration);

    return () => clearInterval(interval);
  }, [cycle, cycleDuration, activeShapes.length, modelUrl, customScene]);

  // Determine content to render
  let Content: ReactNode;

  if (customScene) {
    Content = <AutoRotateScene>{customScene}</AutoRotateScene>;
  } else if (modelUrl) {
    Content = (
      <Suspense fallback={<SpinnerScene />}>
        <ModelScene url={modelUrl} />
      </Suspense>
    );
  } else {
    // Safety check for index
    const index = currentIndex % activeShapes.length;
    const currentShape = activeShapes[index];
    const SceneComponent = shapeScenes[currentShape];
    Content = <SceneComponent />;
  }

  return (
    <div style={{
      width: size,
      height: size,
      transition: `opacity ${TRANSITION_DURATION / 2}ms ease-in-out`,
      opacity: opacity,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      ...style
    }}>
      <AsciiRenderer
        cols={settings.cols}
        rows={settings.rows}
        fps={settings.fps}
        color={color}
        invert={false}
        containerSize={size}
        onReady={onReady}
      >
        {Content}
      </AsciiRenderer>
    </div>
  );
}
