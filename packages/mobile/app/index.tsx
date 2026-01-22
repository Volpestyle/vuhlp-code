import { useCallback, useEffect, useState, useMemo } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import type { RunState } from '@vuhlp/contracts';
import { api } from '@/lib/api';
import { Plus, SortDown, SortUp } from 'iconoir-react-native';
import { colors, getStatusColor, fontFamily, fontSize, radius, spacing } from '@/lib/theme';
import { NewSessionModal } from '@/components/NewSessionModal';
import { PageLoader } from '@/components/PageLoader';
import { SwipeableSessionItem } from '@/components/SwipeableSessionItem';

export default function SessionsScreen() {
  const router = useRouter();
  const [sessions, setSessions] = useState<RunState[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSessionModalVisible, setNewSessionModalVisible] = useState(false);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const dateA = new Date(a.updatedAt).getTime();
      const dateB = new Date(b.updatedAt).getTime();
      return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
    });
  }, [sessions, sortOrder]);

  const toggleSortOrder = useCallback(() => {
    setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      console.log('[SessionsScreen] Fetching sessions');
      const data = await api.listRuns();
      console.log('[SessionsScreen] Fetched', data.length, 'sessions');
      setSessions(data);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch sessions';
      console.error('[SessionsScreen] Error fetching sessions:', message);
      setError(message);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchSessions();
    setRefreshing(false);
  }, [fetchSessions]);

  useEffect(() => {
    fetchSessions().finally(() => setLoading(false));
  }, [fetchSessions]);

  const handleOpenNewSessionModal = useCallback(() => {
    console.log('[SessionsScreen] Opening new session modal');
    setNewSessionModalVisible(true);
  }, []);

  const handleCloseNewSessionModal = useCallback(() => {
    console.log('[SessionsScreen] Closing new session modal');
    setNewSessionModalVisible(false);
  }, []);

  const handleSessionCreated = useCallback((session: RunState) => {
    console.log('[SessionsScreen] Session created, navigating to:', session.id);
    setSessions((prev) => [session, ...prev]);
    router.push(`/run/${session.id}`);
  }, [router]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    Alert.alert(
      'Delete Session',
      'Are you sure you want to delete this session? This action cannot be undone.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              // Optimistic update
              setSessions((prev) => prev.filter((s) => s.id !== sessionId));
              await api.deleteRun(sessionId);
              console.log('[SessionsScreen] Deleted session:', sessionId);
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Failed to delete session';
              console.error('[SessionsScreen] Error deleting session:', message);
              Alert.alert('Error', 'Failed to delete session. Please try again.');
              // Revert optimistic update
              await fetchSessions();
            }
          },
        },
      ]
    );
  }, [fetchSessions]);

  if (loading) {
    return <PageLoader />;
  }

  if (error) {
    return <PageLoader error={error} onRetry={onRefresh} />;
  }

  return (
    <View style={styles.container}>
      <FlatList
        refreshing={refreshing}
        onRefresh={onRefresh}
        data={sortedSessions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.list, sessions.length === 0 && styles.listEmpty]}
        ListHeaderComponent={
          sessions.length > 0 ? (
            <View style={styles.headerActions}>
              <TouchableOpacity 
                style={styles.sortButton} 
                onPress={toggleSortOrder}
                activeOpacity={0.7}
              >
                <Text style={styles.sortButtonText}>
                  {sortOrder === 'desc' ? 'Newest First' : 'Oldest First'}
                </Text>
                {sortOrder === 'desc' ? (
                  <SortDown width={16} height={16} color={colors.textSecondary} />
                ) : (
                  <SortUp width={16} height={16} color={colors.textSecondary} />
                )}
              </TouchableOpacity>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <SwipeableSessionItem item={item} onDelete={handleDeleteSession} />
        )}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.empty}>No sessions yet</Text>
            <Text style={styles.hint}>Create a session to get started</Text>
          </View>
        }
      />

      {/* Floating action button for new session */}
      <TouchableOpacity
        style={styles.fab}
        onPress={handleOpenNewSessionModal}
        activeOpacity={0.8}
      >
        <Plus width={18} height={18} color={colors.bgPrimary} strokeWidth={2.5} />
        <Text style={styles.fabLabel}>New Session</Text>
      </TouchableOpacity>

      {/* New session modal */}
      <NewSessionModal
        visible={newSessionModalVisible}
        onClose={handleCloseNewSessionModal}
        onSuccess={handleSessionCreated}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing['3xl'],
  },
  empty: {
    color: colors.textSecondary,
    fontSize: fontSize['2xl'],
    fontFamily: fontFamily.semibold,
  },
  hint: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    marginTop: spacing.md,
  },
  list: {
    padding: spacing.xl,
    paddingBottom: 100, // Space for FAB
    gap: spacing.lg,
    flexGrow: 1,
  },
  listEmpty: {
    flex: 1,
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    padding: spacing.xl,
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
  fab: {
    position: 'absolute',
    bottom: spacing['3xl'],
    right: spacing.xl,
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  fabLabel: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.sm,
    color: colors.bgPrimary,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  headerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  sortButtonText: {
    fontSize: fontSize.xs,
    fontFamily: fontFamily.medium,
    color: colors.textSecondary,
  },
});
