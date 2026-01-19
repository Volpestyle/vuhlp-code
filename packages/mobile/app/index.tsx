import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import type { RunState } from '@vuhlp/contracts';
import { api } from '@/lib/api';
import { Plus } from 'iconoir-react-native';
import { colors, getStatusColor, fontFamily, fontSize, radius, spacing } from '@/lib/theme';
import { NewSessionModal } from '@/components/NewSessionModal';

export default function SessionsScreen() {
  const router = useRouter();
  const [sessions, setSessions] = useState<RunState[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSessionModalVisible, setNewSessionModalVisible] = useState(false);

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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.textMuted} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Text style={styles.hint}>Check that the daemon is running</Text>
        </View>
        {/* Still show FAB to create session */}
        <TouchableOpacity
          style={styles.fab}
          onPress={handleOpenNewSessionModal}
          activeOpacity={0.8}
        >
          <Plus width={18} height={18} color={colors.bgPrimary} strokeWidth={2.5} />
          <Text style={styles.fabLabel}>New Session</Text>
        </TouchableOpacity>
        <NewSessionModal
          visible={newSessionModalVisible}
          onClose={handleCloseNewSessionModal}
          onSuccess={handleSessionCreated}
        />
      </View>
    );
  }

  if (sessions.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.empty}>No sessions yet</Text>
          <Text style={styles.hint}>Create a session to get started</Text>
        </View>
        <TouchableOpacity
          style={styles.fab}
          onPress={handleOpenNewSessionModal}
          activeOpacity={0.8}
        >
          <Plus width={18} height={18} color={colors.bgPrimary} strokeWidth={2.5} />
          <Text style={styles.fabLabel}>New Session</Text>
        </TouchableOpacity>
        <NewSessionModal
          visible={newSessionModalVisible}
          onClose={handleCloseNewSessionModal}
          onSuccess={handleSessionCreated}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        refreshing={refreshing}
        onRefresh={onRefresh}
        data={sessions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
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
        )}
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
  error: {
    color: colors.statusFailed,
    fontSize: fontSize.lg,
    textAlign: 'center',
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
});
