import { CSSProperties, useEffect, useRef } from 'react';
import { motion, useMotionValue } from 'framer-motion';
import './ThinkingSpinner.css';

type SpinnerSize = 'sm' | 'md' | 'lg';
type SpinnerVariant = 'globe' | 'tumble' | 'continuous';

interface ThinkingSpinnerProps {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
  className?: string;
}

export function ThinkingSpinner({
  size = 'sm',
  variant = 'globe',
  className = '',
}: ThinkingSpinnerProps) {
  const sizeMap = {
    sm: 8,
    md: 12,
    lg: 16,
  };

  const cubeSize = sizeMap[size];

  // Direct rotation values (we'll animate these manually for momentum effect)
  const rotateY = useMotionValue(0);
  const rotateX = useMotionValue(0);
  const tilt = useMotionValue(-20); // Base tilt angle
  const scale = useMotionValue(1);

  // Store animation state in ref to persist across frames
  const animState = useRef({
    velocityY: 0,
    velocityX: 0,
    currentY: 0,
    currentX: 0,
    axis: 'Y' as 'Y' | 'X',
    phase: 'spinning' as 'spinning' | 'stopped',
    stoppedTime: 0,
  });

  useEffect(() => {
    if (variant !== 'globe') return;

    let frame: number;
    const rotationsPerSpin = 3; // Number of full 360° rotations per spin
    const spinDuration = 1800; // Total duration for the spin (ms)
    const pauseDuration = 400; // Pause before switching axis (ms)

    const state = animState.current;
    state.axis = 'Y';
    state.phase = 'spinning';
    state.stoppedTime = 0;

    let spinStartTime = performance.now();
    let startAngle = 0;

    // Ease in-out curve (cubic bezier approximation)
    const easeInOut = (t: number): number => {
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    };

    const animate = () => {
      const now = performance.now();
      const time = now / 1000;

      // Breathing scale
      scale.set(1 + Math.sin(time * 0.8) * 0.03 + Math.sin(time * 1.7) * 0.015);

      // Subtle tilt wobble
      tilt.set(-20 + Math.sin(time * 0.6) * 3 + Math.sin(time * 1.1) * 2);

      if (state.phase === 'spinning') {
        const elapsed = now - spinStartTime;
        const progress = Math.min(elapsed / spinDuration, 1);
        const easedProgress = easeInOut(progress);

        // Calculate target: multiple rotations landing on 90° increment
        const totalRotation = rotationsPerSpin * 360 + 90; // Extra 90° to land on next increment
        const currentRotation = startAngle + easedProgress * totalRotation;

        if (state.axis === 'Y') {
          state.currentY = currentRotation;
          rotateY.set(currentRotation);
        } else {
          state.currentX = currentRotation;
          rotateX.set(currentRotation);
        }

        // Check if spin complete
        if (progress >= 1) {
          state.phase = 'stopped';
          state.stoppedTime = now;
        }
      } else if (state.phase === 'stopped') {
        // Wait then switch axis
        if (now - state.stoppedTime >= pauseDuration) {
          if (state.axis === 'Y') {
            state.axis = 'X';
            startAngle = state.currentX;
          } else {
            state.axis = 'Y';
            startAngle = state.currentY;
          }
          spinStartTime = now;
          state.phase = 'spinning';
        }
      }

      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [variant, rotateY, rotateX, tilt, scale]);

  // Tumble variant (quarter turns)
  useEffect(() => {
    if (variant !== 'tumble') return;

    let frame: number;
    let currentY = 0;
    let currentX = 0;
    let phase: 'spinY' | 'pauseY' | 'spinX' | 'pauseX' = 'spinY';
    let phaseStart = performance.now();
    let targetY = 90;
    let targetX = 0;

    const spinDuration = 600;
    const pauseDuration = 200;
    const springSpeed = 0.08;
    const springDamping = 0.85;
    let velY = 0;
    let velX = 0;

    const animate = () => {
      const now = performance.now();
      const elapsed = now - phaseStart;
      const time = now / 1000;

      // Breathing scale
      scale.set(1 + Math.sin(time * 0.8) * 0.03 + Math.sin(time * 1.7) * 0.015);

      // Spring physics for smooth movement
      velY += (targetY - currentY) * springSpeed;
      velY *= springDamping;
      currentY += velY;
      rotateY.set(currentY);

      velX += (targetX - currentX) * springSpeed;
      velX *= springDamping;
      currentX += velX;
      rotateX.set(currentX);

      // State machine for sequenced rotation
      switch (phase) {
        case 'spinY':
          if (elapsed >= spinDuration) {
            targetY += 90;
            phase = 'pauseY';
            phaseStart = now;
          }
          break;
        case 'pauseY':
          if (elapsed >= pauseDuration) {
            phase = 'spinX';
            phaseStart = now;
          }
          break;
        case 'spinX':
          if (elapsed >= spinDuration) {
            targetX += 90;
            phase = 'pauseX';
            phaseStart = now;
          }
          break;
        case 'pauseX':
          if (elapsed >= pauseDuration) {
            phase = 'spinY';
            phaseStart = now;
          }
          break;
      }

      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [variant, rotateY, rotateX, scale]);

  // Continuous variant (original smooth spinning)
  useEffect(() => {
    if (variant !== 'continuous') return;

    let frame: number;
    let rotation = 0;

    const animate = () => {
      const time = performance.now() / 1000;

      // Irregular rotation - varies speed slightly
      const speed = 0.008 + Math.sin(rotation * 3) * 0.004;
      rotation += speed;
      rotateY.set(rotation * 360);

      // Gentle tilt oscillation
      tilt.set(-25 + Math.sin(rotation * Math.PI * 2) * 5);

      // Breathing scale
      scale.set(1 + Math.sin(time * 0.8) * 0.03 + Math.sin(time * 1.7) * 0.015);

      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [variant, rotateY, tilt, scale]);

  return (
    <span
      className={`thinking-spinner thinking-spinner--${size} ${className}`}
      role="status"
      aria-label="loading"
      style={{ '--cube-size': `${cubeSize}px` } as CSSProperties}
    >
      <div className="cube-scene">
        <motion.div
          className="cube-tilt"
          style={{
            rotateX: variant === 'tumble' ? 0 : tilt,
          }}
        >
          <motion.div
            className="cube"
            style={{
              rotateY,
              rotateX,
              scale,
            }}
          >
            <div className="cube-face cube-face--front" />
            <div className="cube-face cube-face--back" />
            <div className="cube-face cube-face--right" />
            <div className="cube-face cube-face--left" />
            <div className="cube-face cube-face--top" />
            <div className="cube-face cube-face--bottom" />
          </motion.div>
        </motion.div>
      </div>
    </span>
  );
}
