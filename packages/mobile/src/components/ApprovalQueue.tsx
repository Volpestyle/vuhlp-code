import { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGraphStore, type PendingApproval } from '@/stores/graph-store';
import { api } from '@/lib/api';

export function ApprovalQueue() {
  const insets = useSafeAreaInsets();
  const pendingApprovals = useGraphStore((s) => s.pendingApprovals);
  const nodes = useGraphStore((s) => s.nodes);
  const removeApproval = useGraphStore((s) => s.removeApproval);

  const handleApprove = useCallback(
    async (approval: PendingApproval) => {
      try {
        await api.resolveApproval(approval.id, { status: 'approved' });
        removeApproval(approval.id);
      } catch (err) {
        console.error('[approval] failed to approve:', err);
      }
    },
    [removeApproval]
  );

  const handleDeny = useCallback(
    async (approval: PendingApproval) => {
      try {
        await api.resolveApproval(approval.id, { status: 'denied', reason: 'Denied by user' });
        removeApproval(approval.id);
      } catch (err) {
        console.error('[approval] failed to deny:', err);
      }
    },
    [removeApproval]
  );

  if (pendingApprovals.length === 0) {
    return null;
  }

  return (
    <View style={[styles.container, { top: insets.top + 60 }]}>
      <View style={styles.header}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{pendingApprovals.length}</Text>
        </View>
        <Text style={styles.title}>Pending Approvals</Text>
      </View>

      <ScrollView
        style={styles.list}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
      >
        {pendingApprovals.map((approval) => {
          const node = nodes.find((n) => n.id === approval.nodeId);
          return (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              nodeLabel={node?.label ?? 'Unknown'}
              onApprove={() => handleApprove(approval)}
              onDeny={() => handleDeny(approval)}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}

interface ApprovalCardProps {
  approval: PendingApproval;
  nodeLabel: string;
  onApprove: () => void;
  onDeny: () => void;
}

function ApprovalCard({ approval, nodeLabel, onApprove, onDeny }: ApprovalCardProps) {
  const argsPreview = Object.entries(approval.toolArgs)
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${truncate(String(v), 20)}`)
    .join(', ');

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.toolName}>{approval.toolName}</Text>
        <Text style={styles.nodeLabel}>{nodeLabel}</Text>
      </View>

      {argsPreview && <Text style={styles.argsPreview}>{argsPreview}</Text>}

      {approval.context && (
        <Text style={styles.context} numberOfLines={2}>
          {approval.context}
        </Text>
      )}

      <View style={styles.actions}>
        <Pressable style={styles.denyButton} onPress={onDeny}>
          <Text style={styles.denyText}>Deny</Text>
        </Pressable>
        <Pressable style={styles.approveButton} onPress={onApprove}>
          <Text style={styles.approveText}>Approve</Text>
        </Pressable>
      </View>
    </View>
  );
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 100,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  badge: {
    backgroundColor: '#ef4444',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  title: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    gap: 12,
    paddingRight: 12,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ef4444',
    padding: 12,
    width: 260,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  toolName: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  nodeLabel: {
    color: '#666',
    fontSize: 12,
  },
  argsPreview: {
    color: '#888',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 8,
  },
  context: {
    color: '#888',
    fontSize: 12,
    marginBottom: 12,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  denyButton: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  denyText: {
    color: '#888',
    fontSize: 14,
    fontWeight: '500',
  },
  approveButton: {
    flex: 1,
    backgroundColor: '#22c55e',
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  approveText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
