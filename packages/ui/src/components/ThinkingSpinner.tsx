import { CSSProperties, useEffect } from 'react';
import {
  motion,
  useSpring,
  useTransform,
  useMotionValue,
} from 'framer-motion';
import './ThinkingSpinner.css';

type SpinnerSize = 'sm' | 'md' | 'lg';

interface ThinkingSpinnerProps {
  size?: SpinnerSize;
  className?: string;
}

export function ThinkingSpinner({
  size = 'sm',
  className = '',
}: ThinkingSpinnerProps) {
  const sizeMap = {
    sm: 8,
    md: 12,
    lg: 16,
  };

  const cubeSize = sizeMap[size];

  // Base rotation value that we manually animate
  const rotationProgress = useMotionValue(0);

  // Spring-based rotation with natural physics
  const springRotation = useSpring(rotationProgress, {
    stiffness: 30,
    damping: 15,
    mass: 1,
  });

  // Transform to actual rotation degrees
  const rotateY = useTransform(springRotation, (v) => v * 360);
  const rotateX = useTransform(springRotation, (v) => -25 + Math.sin(v * Math.PI * 2) * 5);

  // Wobble springs - subtle organic tilt
  const wobbleX = useMotionValue(0);
  const wobbleZ = useMotionValue(0);
  const springWobbleX = useSpring(wobbleX, { stiffness: 50, damping: 10 });
  const springWobbleZ = useSpring(wobbleZ, { stiffness: 40, damping: 12 });

  // Scale spring for breathing effect
  const scaleValue = useMotionValue(1);
  const springScale = useSpring(scaleValue, { stiffness: 60, damping: 15 });

  useEffect(() => {
    let frame: number;
    let rotation = 0;

    const animate = () => {
      // Irregular rotation - varies speed
      const speed = 0.008 + Math.sin(rotation * 3) * 0.004;
      rotation += speed;
      rotationProgress.set(rotation);

      // Organic wobble with varying intensity
      const time = performance.now() / 1000;
      wobbleX.set(Math.sin(time * 0.7) * 3 + Math.sin(time * 1.3) * 1.5);
      wobbleZ.set(Math.cos(time * 0.5) * 2 + Math.cos(time * 1.1) * 1);

      // Breathing scale
      scaleValue.set(1 + Math.sin(time * 0.8) * 0.03 + Math.sin(time * 1.7) * 0.015);

      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [rotationProgress, wobbleX, wobbleZ, scaleValue]);

  return (
    <span
      className={`thinking-spinner thinking-spinner--${size} ${className}`}
      role="status"
      aria-label="loading"
      style={{ '--cube-size': `${cubeSize}px` } as CSSProperties}
    >
      <div className="cube-scene">
        <motion.div
          className="cube-wobble"
          style={{
            rotateX: springWobbleX,
            rotateZ: springWobbleZ,
            scale: springScale,
          }}
        >
          <motion.div
            className="cube"
            style={{
              rotateY,
              rotateX,
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
