/**
 * RunControlsPanel - Collapsible panel with global run controls
 *
 * Animation modeled after Claude Code tools drawer:
 * - Smooth ease-out timing animation
 * - Content fades in with slight delay
 * - Chevron rotates smoothly
 */

import { useCallback, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Alert,
  Platform,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  withTiming,
  useSharedValue,
  interpolate,
  Extrapolation,
  Easing,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import {
  Play,
  Pause,
  NavArrowDown,
} from 'iconoir-react-native';
import { useGraphStore } from '@/stores/graph-store';
import { api } from '@/lib/api';
import { colors, fontFamily, fontSize, radius, spacing } from '@/lib/theme';
import type { RunState } from '@vuhlp/contracts';

// Animation config matching Claude Code tools drawer feel
const ANIMATION_DURATION = 280;
const EASING = Easing.bezier(0.25, 0.1, 0.25, 1); // Smooth ease-out
const CONTENT_DELAY = 80;

const COLLAPSED_HEIGHT = 40;
const EXPANDED_HEIGHT = 92;

interface RunControlsPanelProps {
  runId: string;
  /** Shared value that tracks the current panel height - use this to position elements below */
  panelHeight: SharedValue<number>;
}

export function RunControlsPanel({ runId, panelHeight }: RunControlsPanelProps) {
  const run = useGraphStore((s) => s.run);
  const applyRunPatch = useGraphStore((s) => s.applyRunPatch);
  const [expanded, setExpanded] = useState(false);
  const [updating, setUpdating] = useState(false);
  const expandProgress = useSharedValue(0);

  const isRunning = run?.status === 'running';
  const isPaused = run?.status === 'paused';
  const isStopped = run?.status === 'stopped';
  const isAuto = run?.mode === 'AUTO';
  const isImplementation = run?.globalMode === 'IMPLEMENTATION';

  const toggleExpanded = useCallback(() => {
    const next = !expanded;
    setExpanded(next);

    // Animate progress
    expandProgress.value = withTiming(next ? 1 : 0, {
      duration: ANIMATION_DURATION,
      easing: EASING,
    });

    // Animate panel height (exposed to parent)
    panelHeight.value = withTiming(next ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT, {
      duration: ANIMATION_DURATION,
      easing: EASING,
    });
  }, [expanded, expandProgress, panelHeight]);

  const updateRunState = useCallback(
    async (patch: Partial<Pick<RunState, 'status' | 'mode' | 'globalMode'>>) => {
      if (!run) {
        console.warn('[RunControlsPanel] cannot update run: no run state');
        return;
      }
      setUpdating(true);
      try {
        console.log('[RunControlsPanel] updating run', { runId: run.id, patch });
        const updated = await api.updateRun(run.id, patch);
        applyRunPatch(patch);
        console.log('[RunControlsPanel] run updated successfully', { status: updated.status });
      } catch (error) {
        console.error('[RunControlsPanel] failed to update run', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        Alert.alert('Update failed', message);
      } finally {
        setUpdating(false);
      }
    },
    [run, applyRunPatch]
  );

  const handleTogglePlayPause = useCallback(() => {
    if (updating) return;
    void updateRunState({ status: isRunning ? 'paused' : 'running' });
  }, [isRunning, updateRunState, updating]);

  const handleStop = useCallback(() => {
    if (updating || isStopped) return;
    Alert.alert(
      'Stop Run',
      'This will terminate all agent sessions. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop',
          style: 'destructive',
          onPress: () => void updateRunState({ status: 'stopped' }),
        },
      ]
    );
  }, [isStopped, updateRunState, updating]);

  const handleToggleOrchestrationMode = useCallback(() => {
    if (updating) return;
    void updateRunState({ mode: isAuto ? 'INTERACTIVE' : 'AUTO' });
  }, [isAuto, updateRunState, updating]);

  const handleToggleGlobalMode = useCallback(() => {
    if (updating) return;
    void updateRunState({ globalMode: isImplementation ? 'PLANNING' : 'IMPLEMENTATION' });
  }, [isImplementation, updateRunState, updating]);

  const getStatusColor = () => {
    if (isRunning) return colors.statusRunning;
    if (isPaused) return colors.statusBlocked;
    if (isStopped) return colors.statusFailed;
    return colors.textMuted;
  };

  // Container height animation
  const containerStyle = useAnimatedStyle(() => {
    const height = interpolate(
      expandProgress.value,
      [0, 1],
      [COLLAPSED_HEIGHT, EXPANDED_HEIGHT],
      Extrapolation.CLAMP
    );
    return { height };
  });

  // Chevron rotation
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${interpolate(expandProgress.value, [0, 1], [0, 180])}deg` },
    ],
  }));

  // Content fade + slide with slight delay effect
  const expandedContentStyle = useAnimatedStyle(() => {
    // Remap progress to create delay effect: content starts animating after ~30% of the expand
    const delayedProgress = interpolate(
      expandProgress.value,
      [0.3, 1],
      [0, 1],
      Extrapolation.CLAMP
    );

    return {
      opacity: delayedProgress,
      transform: [
        { translateY: interpolate(delayedProgress, [0, 1], [-6, 0]) },
      ],
    };
  });

  return (
    <Animated.View style={[styles.container, containerStyle]}>
      {/* Blur background */}
      {Platform.OS === 'ios' ? (
        <BlurView intensity={40} style={StyleSheet.absoluteFill} tint="dark" />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.85)' }]} />
      )}

      {/* Collapsed header - always visible */}
      <Pressable style={styles.collapsedHeader} onPress={toggleExpanded}>
        <View style={styles.statusSection}>
          <View style={[styles.statusDot, { backgroundColor: getStatusColor() }]} />
          <Text style={styles.statusText}>
            {run?.status?.toUpperCase() ?? 'IDLE'}
          </Text>
          <View style={styles.modeBadgeContainer}>
            <Text style={styles.modeBadge}>
              {run?.mode ?? 'AUTO'}
            </Text>
            <Text style={styles.modeSeparator}>·</Text>
            <Text style={styles.modeBadge}>
              {run?.globalMode === 'IMPLEMENTATION' ? 'IMPL' : 'PLAN'}
            </Text>
          </View>
        </View>
        <Animated.View style={chevronStyle}>
          <NavArrowDown width={18} height={18} color={colors.textMuted} strokeWidth={2} />
        </Animated.View>
      </Pressable>

      {/* Expanded content */}
      <Animated.View style={[styles.expandedContent, expandedContentStyle]} pointerEvents={expanded ? 'auto' : 'none'}>
        <View style={styles.controlsRow}>
          {/* Mode toggles */}
          <Pressable
            style={[styles.toggleButton, isAuto && styles.toggleButtonActive]}
            onPress={handleToggleOrchestrationMode}
            disabled={updating}
          >
            <Text style={[styles.toggleLabel, isAuto && styles.toggleLabelActive]}>
              {run?.mode ?? 'AUTO'}
            </Text>
          </Pressable>

          <Pressable
            style={[styles.toggleButton, isImplementation && styles.toggleButtonActive]}
            onPress={handleToggleGlobalMode}
            disabled={updating}
          >
            <Text style={[styles.toggleLabel, isImplementation && styles.toggleLabelActive]}>
              {run?.globalMode === 'IMPLEMENTATION' ? 'IMPL' : 'PLAN'}
            </Text>
          </Pressable>

          <View style={styles.spacer} />

          {/* Play/Pause - can always start, even from stopped */}
          <Pressable
            style={[
              styles.actionButton,
              isRunning ? styles.actionButtonPause : styles.actionButtonPlay,
              updating && styles.buttonDisabled,
            ]}
            onPress={handleTogglePlayPause}
            disabled={updating}
          >
            {isRunning ? (
              <Pause width={16} height={16} color={colors.bgPrimary} strokeWidth={2} />
            ) : (
              <Play width={16} height={16} color={colors.bgPrimary} strokeWidth={2} />
            )}
          </Pressable>

          {/* Spacer between play and stop */}
          <View style={styles.buttonSpacer} />

          {/* Stop - disabled when already stopped */}
          <Pressable
            style={[
              styles.actionButton,
              styles.actionButtonStop,
              (isStopped || updating) && styles.buttonDisabled,
            ]}
            onPress={handleStop}
            disabled={updating || isStopped}
          >
            <View style={styles.stopIcon} />
          </Pressable>
        </View>
      </Animated.View>

      {/* Bottom border */}
      <View style={styles.bottomBorder} />
    </Animated.View>
  );
}

// Export heights for other components to use
export const RUN_CONTROLS_COLLAPSED_HEIGHT = COLLAPSED_HEIGHT;
export const RUN_CONTROLS_EXPANDED_HEIGHT = EXPANDED_HEIGHT;

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    overflow: 'hidden',
  },
  collapsedHeader: {
    height: COLLAPSED_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  },
  statusSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontFamily: fontFamily.semibold,
    letterSpacing: 0.5,
  },
  modeBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: spacing.md,
    gap: spacing.xs,
  },
  modeBadge: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontFamily: fontFamily.medium,
  },
  modeSeparator: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  expandedContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  toggleButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleButtonActive: {
    backgroundColor: colors.accentSubtle,
    borderColor: colors.accentDim,
  },
  toggleLabel: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontFamily: fontFamily.semibold,
    letterSpacing: 0.5,
  },
  toggleLabelActive: {
    color: colors.accent,
  },
  spacer: {
    flex: 1,
  },
  buttonSpacer: {
    width: spacing.md,
  },
  actionButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonPlay: {
    backgroundColor: colors.statusRunning,
  },
  actionButtonPause: {
    backgroundColor: colors.statusBlocked,
  },
  actionButtonStop: {
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.statusFailed,
  },
  stopIcon: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: colors.statusFailed,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  bottomBorder: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.border,
  },
});
