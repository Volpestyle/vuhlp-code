import { useRef, useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { Canvas, useFrame } from '@react-three/fiber/native';
import * as THREE from 'three';
import {
  SpinnerSize,
  SpinnerVariant,
  SIZE_MAP,
  ASSEMBLE_PART_SIZE,
  ASSEMBLE_PART_OFFSETS,
  ASSEMBLE_PRIMARY_INDEX,
  ASSEMBLE_TIMING,
  GLOBE_TIMING,
  TUMBLE_TIMING,
  GlobeState,
  TumbleState,
  AssembleState,
  easeInOut,
  createGlobeState,
  createTumbleState,
  createAssembleState,
  getBreathScale,
  getTiltAngle,
  getCubeState,
  getAssembleRotationSpeed,
  getNextAssemblePhase,
} from '@vuhlp/spinners';

interface ThinkingSpinnerProps {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
  color?: string;
}

interface AnimatedCubeProps {
  variant: SpinnerVariant;
  color: string;
}

function AnimatedCube({ variant, color }: AnimatedCubeProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const edgesRef = useRef<THREE.LineSegments>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const assembleGroupRef = useRef<THREE.Group>(null);
  const assembleMeshRefs = useRef<Array<THREE.Mesh | null>>([]);
  const assembleEdgeRefs = useRef<Array<THREE.LineSegments | null>>([]);
  const assembleState = useRef<AssembleState>({
    phase: 'holdSmall',
    phaseStart: 0,
    rotation: 0,
  });
  const assembleWarnedRef = useRef(false);

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

  const continuousState = useRef({ rotation: 0 });

  const fullCubeMeshRef = useRef<THREE.Mesh>(null);
  const fullCubeEdgesRef = useRef<THREE.LineSegments>(null);

  useEffect(() => {
    const now = performance.now();
    globeState.current = createGlobeState(now);
    tumbleState.current = createTumbleState(now);
    continuousState.current = { rotation: 0 };
    assembleState.current = createAssembleState(now);
    assembleWarnedRef.current = false;
  }, [variant]);

  useFrame((_, delta) => {
    const now = performance.now();
    const time = now / 1000;
    const breathScale = getBreathScale(time);

    if (variant === 'assemble') {
      const group = assembleGroupRef.current;
      if (!group) {
        if (!assembleWarnedRef.current) {
          console.warn('[thinking-spinner] assemble group not ready');
          assembleWarnedRef.current = true;
        }
        return;
      }

      const state = assembleState.current;
      const elapsed = now - state.phaseStart;
      const { speed, phaseDuration, showFullCube } = getAssembleRotationSpeed(state.phase, elapsed);

      if (elapsed >= phaseDuration) {
        state.phase = getNextAssemblePhase(state.phase);
        state.phaseStart = now;
      }

      state.rotation += speed * delta;
      group.rotation.y += speed * delta;
      group.scale.setScalar(breathScale);

      if (fullCubeMeshRef.current && fullCubeEdgesRef.current) {
        fullCubeMeshRef.current.visible = showFullCube;
        fullCubeEdgesRef.current.visible = showFullCube;
      }

      ASSEMBLE_PART_OFFSETS.forEach((offset, index) => {
        const mesh = assembleMeshRefs.current[index];
        const edges = assembleEdgeRefs.current[index];
        if (!mesh || !edges) return;

        if (showFullCube) {
          mesh.visible = false;
          edges.visible = false;
          return;
        }

        let scale = 0;
        let travel = 0;

        switch (state.phase) {
          case 'holdSmall':
            scale = 0;
            travel = 0;
            break;
          case 'assembling': {
            const res = getCubeState(index, 'in', elapsed);
            scale = res.scale;
            travel = res.travel;
            break;
          }
          case 'holdFull':
            scale = 1;
            travel = 1;
            break;
          case 'disassembling': {
            const res = getCubeState(index, 'out', elapsed);
            scale = res.scale;
            travel = res.travel;
            break;
          }
        }

        mesh.scale.setScalar(scale);
        edges.scale.setScalar(scale);

        const isVisible = scale > 0.01;
        mesh.visible = isVisible;
        edges.visible = isVisible;

        const { flyStartDistance } = ASSEMBLE_TIMING;
        const distMult = 1 + (flyStartDistance - 1) * (1 - travel);

        mesh.position.set(offset[0] * distMult, offset[1] * distMult, offset[2] * distMult);
        edges.position.set(offset[0] * distMult, offset[1] * distMult, offset[2] * distMult);
      });
      return;
    }

    if (!meshRef.current || !tiltRef.current) return;

    meshRef.current.scale.setScalar(breathScale);
    if (edgesRef.current) {
      edgesRef.current.scale.setScalar(breathScale);
    }

    if (variant === 'globe') {
      const state = globeState.current;
      const { rotationsPerSpin, spinDuration, pauseDuration } = GLOBE_TIMING;

      tiltRef.current.rotation.x = getTiltAngle(time);

      if (state.phase === 'spinning') {
        const elapsed = now - state.spinStartTime;
        const progress = Math.min(elapsed / spinDuration, 1);
        const easedProgress = easeInOut(progress);
        const totalRotation = rotationsPerSpin * Math.PI * 2 + Math.PI / 2;

        if (state.axis === 'Y') {
          state.currentY = state.startAngleY + easedProgress * totalRotation;
          meshRef.current.rotation.y = state.currentY;
          if (edgesRef.current) edgesRef.current.rotation.y = state.currentY;
        } else {
          state.currentX = state.startAngleX + easedProgress * totalRotation;
          meshRef.current.rotation.x = state.currentX;
          if (edgesRef.current) edgesRef.current.rotation.x = state.currentX;
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
      const { spinDuration, pauseDuration, springSpeed, springDamping } = TUMBLE_TIMING;
      const elapsed = now - state.phaseStart;

      state.velY += (state.targetY - state.currentY) * springSpeed;
      state.velY *= springDamping;
      state.currentY += state.velY;

      state.velX += (state.targetX - state.currentX) * springSpeed;
      state.velX *= springDamping;
      state.currentX += state.velX;

      meshRef.current.rotation.y = state.currentY;
      meshRef.current.rotation.x = state.currentX;
      if (edgesRef.current) {
        edgesRef.current.rotation.y = state.currentY;
        edgesRef.current.rotation.x = state.currentX;
      }

      tiltRef.current.rotation.x = getTiltAngle(time);

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
      const speed = 0.008 + Math.sin(state.rotation * 3) * 0.004;
      state.rotation += speed;

      meshRef.current.rotation.y = state.rotation * Math.PI * 2;
      if (edgesRef.current) {
        edgesRef.current.rotation.y = state.rotation * Math.PI * 2;
      }

      tiltRef.current.rotation.x = getTiltAngle(time);
    }
  });

  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const assembleGeometry = new THREE.BoxGeometry(
    ASSEMBLE_PART_SIZE,
    ASSEMBLE_PART_SIZE,
    ASSEMBLE_PART_SIZE
  );

  if (variant === 'assemble') {
    return (
      <group ref={assembleGroupRef}>
        <mesh ref={fullCubeMeshRef} visible={false}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color={color} roughness={0.5} metalness={0.2} />
        </mesh>
        <lineSegments ref={fullCubeEdgesRef} visible={false}>
          <edgesGeometry args={[boxGeometry]} />
          <lineBasicMaterial color={color} transparent opacity={0.4} />
        </lineSegments>

        {ASSEMBLE_PART_OFFSETS.map((_, index) => (
          <group key={`assemble-part-${index}`}>
            <mesh
              ref={(node) => {
                assembleMeshRefs.current[index] = node;
              }}
              position={[0, 0, 0]}
              scale={index === ASSEMBLE_PRIMARY_INDEX ? 1 : 0}
              visible={index === ASSEMBLE_PRIMARY_INDEX}
            >
              <boxGeometry args={[ASSEMBLE_PART_SIZE, ASSEMBLE_PART_SIZE, ASSEMBLE_PART_SIZE]} />
              <meshStandardMaterial color={color} roughness={0.5} metalness={0.2} />
            </mesh>
            <lineSegments
              ref={(node) => {
                assembleEdgeRefs.current[index] = node;
              }}
              position={[0, 0, 0]}
              scale={index === ASSEMBLE_PRIMARY_INDEX ? 1 : 0}
              visible={index === ASSEMBLE_PRIMARY_INDEX}
            >
              <edgesGeometry args={[assembleGeometry]} />
              <lineBasicMaterial color={color} transparent opacity={0.4} />
            </lineSegments>
          </group>
        ))}
      </group>
    );
  }

  return (
    <group ref={tiltRef}>
      <mesh ref={meshRef}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.2} />
      </mesh>
      <lineSegments ref={edgesRef}>
        <edgesGeometry args={[boxGeometry]} />
        <lineBasicMaterial color={color} transparent opacity={0.4} />
      </lineSegments>
    </group>
  );
}

export function ThinkingSpinner({
  size = 'sm',
  variant = 'globe',
  color = '#8ab4f8',
}: ThinkingSpinnerProps) {
  const pixelSize = SIZE_MAP?.[size] ?? 24;
  
  return (
    <View
      style={[styles.container, { width: pixelSize, height: pixelSize }]}
      accessibilityRole="progressbar"
      accessibilityLabel="loading"
    >
      <Canvas
        style={styles.canvas}
        camera={{ position: [0, 0, 2.5], fov: 50 }}
        onCreated={(state) => {
          state.gl.debug.checkShaderErrors = false;
        }}
      >
        <ambientLight intensity={0.5} />
        <hemisphereLight args={['#ffffff', '#222222', 0.4]} />
        <directionalLight position={[3, 3, 5]} intensity={0.9} />
        <directionalLight position={[-2, -2, -3]} intensity={0.35} />
        <AnimatedCube variant={variant} color={color} />
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  canvas: {
    width: '100%',
    height: '100%',
  },
});
