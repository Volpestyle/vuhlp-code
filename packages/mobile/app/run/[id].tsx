import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, LayoutChangeEvent, TouchableOpacity } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGraphStore } from '@/stores/graph-store';
import { useRunConnection } from '@/lib/useRunConnection';
import { GraphCanvas } from '@/components/GraphCanvas';
import { GraphMinimap } from '@/components/GraphMinimap';
import { NodeInspector } from '@/components/NodeInspector';
import { ApprovalQueue } from '@/components/ApprovalQueue';
import { NewNodeModal } from '@/components/NewNodeModal';
import { Plus } from 'iconoir-react-native';
import { colors, fontFamily, fontSize, radius, spacing } from '@/lib/theme';

export default function RunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { loading, error, connected } = useRunConnection(id);
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const edgeCount = useGraphStore((s) => s.edges.length);
  const pendingCount = useGraphStore((s) => s.pendingApprovals.length);
  const [statusBarHeight, setStatusBarHeight] = useState(0);
  const [newNodeModalVisible, setNewNodeModalVisible] = useState(false);

  const handleStatusBarLayout = useCallback((event: LayoutChangeEvent) => {
    setStatusBarHeight(event.nativeEvent.layout.height);
  }, []);

  const handleOpenNewNodeModal = useCallback(() => {
    console.log('[RunScreen] Opening new node modal');
    setNewNodeModalVisible(true);
  }, []);

  const handleCloseNewNodeModal = useCallback(() => {
    console.log('[RunScreen] Closing new node modal');
    setNewNodeModalVisible(false);
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#666" />
        <Text style={styles.loadingText}>Connecting to session...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <GraphCanvas />

      {/* Floating minimap for navigation */}
      <GraphMinimap />

      {/* Floating approval queue */}
      <ApprovalQueue />

      {/* Floating action button for new node */}
      <TouchableOpacity
        style={styles.fab}
        onPress={handleOpenNewNodeModal}
        activeOpacity={0.8}
      >
        <Plus width={18} height={18} color={colors.bgPrimary} strokeWidth={2.5} />
        <Text style={styles.fabLabel}>New Node</Text>
      </TouchableOpacity>

      {/* New node modal */}
      <NewNodeModal
        visible={newNodeModalVisible}
        onClose={handleCloseNewNodeModal}
        runId={id}
      />

      {/* Bottom inspector sheet */}
      <NodeInspector bottomOverlayHeight={statusBarHeight} />

      {/* Status bar */}
      <View style={styles.statusBar} onLayout={handleStatusBarLayout}>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, connected ? styles.connected : styles.disconnected]} />
          <Text style={styles.statusText}>
            {nodeCount} nodes · {edgeCount} edges
            {pendingCount > 0 && ` · ${pendingCount} pending`}
          </Text>
        </View>
      </View>
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
  loadingText: {
    color: colors.textMuted,
    marginTop: spacing.lg,
  },
  error: {
    color: colors.statusFailed,
    fontSize: fontSize.lg,
    textAlign: 'center',
  },
  fab: {
    position: 'absolute',
    bottom: 80,
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
  statusBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.9)',
    padding: spacing.lg,
    paddingBottom: spacing['4xl'],
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connected: {
    backgroundColor: colors.statusRunning,
  },
  disconnected: {
    backgroundColor: colors.statusFailed,
  },
  statusText: {
    color: colors.textMuted,
    fontSize: fontSize.base,
  },
});
