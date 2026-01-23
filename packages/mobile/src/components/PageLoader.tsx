import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { ThinkingSpinner } from '@vuhlp/spinners/native';
import { colors, fontFamily, fontSize, spacing, radius } from '@/lib/theme';

interface PageLoaderProps {
  error?: string | null;
  onRetry?: () => void;
  size?: 'sm' | 'lg';
}

export function PageLoader({ error, onRetry, size = 'lg' }: PageLoaderProps) {
  console.log('[PageLoader] Rendering with error:', error);

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.spinnerContainer}>
          <ThinkingSpinner size={size} variant="assemble" color={colors.accent} />
        </View>
        {error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>UNABLE TO LOAD SESSION</Text>
            <Text style={styles.errorDetail}>{error}</Text>
            {onRetry ? (
              <TouchableOpacity
                style={styles.retryButton}
                onPress={onRetry}
                activeOpacity={0.7}
              >
                <Text style={styles.retryText}>RETRY</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['3xl'],
  },
  spinnerContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ scale: 2.5 }],
  },
  errorContainer: {
    alignItems: 'center',
    marginTop: spacing['2xl'],
  },
  errorTitle: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.base,
    color: colors.textSecondary,
    letterSpacing: 2,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  errorDetail: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.md,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  retryButton: {
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing['2xl'],
  },
  retryText: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    letterSpacing: 1,
  },
});
