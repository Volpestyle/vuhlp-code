import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

type SpinnerSize = 'sm' | 'md' | 'lg';

interface ThinkingSpinnerProps {
  size?: SpinnerSize;
  color?: string;
}

const SIZE_MAP: Record<SpinnerSize, number> = {
  sm: 10,
  md: 14,
  lg: 18,
};

export function ThinkingSpinner({ size = 'sm', color = '#8ab4f8' }: ThinkingSpinnerProps) {
  const cubeSize = SIZE_MAP[size];
  const rotation = useSharedValue(0);
  const wobble = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(1, { duration: 1600, easing: Easing.linear }),
      -1,
      false
    );
    wobble.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
    scale.value = withRepeat(
      withTiming(1.06, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, [rotation, wobble, scale]);

  const animatedStyle = useAnimatedStyle(() => {
    const wobbleAngle = -15 + wobble.value * 30;
    return {
      width: cubeSize,
      height: cubeSize,
      transform: [
        { perspective: cubeSize * 6 },
        { rotateY: `${wobbleAngle}deg` },
        { rotateX: `${wobbleAngle * 0.7}deg` },
        { rotateZ: `${rotation.value * 360}deg` },
        { scale: scale.value },
      ],
    };
  }, [cubeSize, rotation, wobble, scale]);

  return (
    <View style={[styles.scene, { width: cubeSize, height: cubeSize }]}>
      <Animated.View style={[styles.cube, animatedStyle, { borderColor: color }]}>
        <View style={[styles.face, { borderColor: color }]} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  scene: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cube: {
    borderWidth: 1,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  face: {
    width: '60%',
    height: '60%',
    borderWidth: 1,
    borderRadius: 2,
    opacity: 0.35,
  },
});
