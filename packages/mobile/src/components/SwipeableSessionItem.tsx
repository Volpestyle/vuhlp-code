import React from 'react';
import { View, Text, StyleSheet, Pressable, Animated } from 'react-native';
import { Swipeable, TouchableOpacity } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { Trash } from 'iconoir-react-native';
import { RunState } from '@vuhlp/contracts';
import { colors, getStatusColor, fontFamily, fontSize, radius, spacing } from '@/lib/theme';

interface SwipeableSessionItemProps {
  item: RunState;
  onDelete: (id: string) => void;
}

export function SwipeableSessionItem({ item, onDelete }: SwipeableSessionItemProps) {
  const router = useRouter();

  const renderRightActions = (
    progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>
  ) => {
    const scale = dragX.interpolate({
      inputRange: [-80, 0],
      outputRange: [1, 0],
      extrapolate: 'clamp',
    });

    return (
      <TouchableOpacity
        style={styles.deleteAction}
        onPress={() => {
            console.log('Delete button pressed for item:', item.id);
            onDelete(item.id);
        }}
        activeOpacity={0.6}
      >
        <Animated.View style={{ transform: [{ scale }] }}>
          <Trash color={colors.textPrimary} fill={colors.textPrimary} width={28} height={28} />
        </Animated.View>
      </TouchableOpacity>
    );
  };

  return (
    <Swipeable renderRightActions={renderRightActions}>
      <Pressable
        style={styles.card}
        onPress={() => router.push(`/run/${item.id}`)}
      >
        <View style={styles.cardHeader}>
          <View style={[styles.statusDot, { backgroundColor: getStatusColor(item.status) }]} />
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.id.slice(0, 8)}
          </Text>
          <View style={styles.cardBadges}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{item.globalMode}</Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{item.mode}</Text>
            </View>
          </View>
        </View>
        <Text style={styles.cardMeta}>
          {Object.keys(item.nodes).length} nodes · {Object.keys(item.edges).length} edges · {item.status}
        </Text>
        {item.cwd && (
          <Text style={styles.cardCwd} numberOfLines={1}>
            {item.cwd}
          </Text>
        )}
        <Text style={styles.cardDate}>
          {new Date(item.updatedAt).toLocaleString()}
        </Text>
      </Pressable>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSurface,
    padding: spacing.xl,
    // Borders handled by container or separator mostly, but here keeping consistent with previous card style
    // However, for swipeable, usually the background is list background. 
    // The previous implementation had borderRadius and margin/gap.
    // If we use layout gap in FlatList, Swipeable needs to respect that. 
    // Let's keep existing card styling internal to this view, but Swipeable wrapping it.
    // To make swipe look good, the 'underlay' (delete action) and the card should ideally be same height.
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontFamily: fontFamily.mono,
    flex: 1,
  },
  cardBadges: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  badge: {
    backgroundColor: colors.bgElevated,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  badgeText: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontFamily: fontFamily.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontFamily: fontFamily.regular,
  },
  cardCwd: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontFamily: fontFamily.mono,
    marginTop: spacing.sm,
  },
  cardDate: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.md,
  },
  deleteAction: {
    backgroundColor: colors.statusFailed,
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
    borderRadius: radius.lg, // Match card radius
    marginLeft: spacing.md, // Add some spacing if we want it to look like a separate floating action, or 0 if connected
  },
});
