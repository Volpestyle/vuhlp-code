import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, LayoutChangeEvent } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGraphStore } from '@/stores/graph-store';
import { useRunConnection } from '@/lib/useRunConnection';
import { GraphCanvas } from '@/components/GraphCanvas';
import { GraphMinimap } from '@/components/GraphMinimap';
import { NodeInspector } from '@/components/NodeInspector';
import { ApprovalQueue } from '@/components/ApprovalQueue';

export default function RunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { loading, error, connected } = useRunConnection(id);
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const edgeCount = useGraphStore((s) => s.edges.length);
  const pendingCount = useGraphStore((s) => s.pendingApprovals.length);
  const [statusBarHeight, setStatusBarHeight] = useState(0);

  const handleStatusBarLayout = useCallback((event: LayoutChangeEvent) => {
    setStatusBarHeight(event.nativeEvent.layout.height);
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#666" />
        <Text style={styles.loadingText}>Connecting to run...</Text>
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
    backgroundColor: '#0a0a0a',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  loadingText: {
    color: '#666',
    marginTop: 12,
  },
  error: {
    color: '#ef4444',
    fontSize: 16,
    textAlign: 'center',
  },
  statusBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.9)',
    padding: 12,
    paddingBottom: 32,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connected: {
    backgroundColor: '#22c55e',
  },
  disconnected: {
    backgroundColor: '#ef4444',
  },
  statusText: {
    color: '#888',
    fontSize: 12,
  },
});
