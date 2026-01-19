import { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGraphStore, type PendingApproval } from '@/stores/graph-store';
import { api } from '@/lib/api';
import { colors, fontFamily } from '@/lib/theme';

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
    backgroundColor: colors.statusBlocked,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    color: colors.bgPrimary,
    fontSize: 12,
    fontFamily: fontFamily.bold,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 14,
    fontFamily: fontFamily.semibold,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    gap: 12,
    paddingRight: 12,
  },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.statusBlocked,
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
    color: colors.textPrimary,
    fontSize: 14,
    fontFamily: fontFamily.mono,
  },
  nodeLabel: {
    color: colors.textMuted,
    fontSize: 12,
  },
  argsPreview: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: fontFamily.mono,
    marginBottom: 8,
  },
  context: {
    color: colors.textSecondary,
    fontSize: 12,
    marginBottom: 12,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  denyButton: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  denyText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontFamily: fontFamily.semibold,
    letterSpacing: 0.3,
  },
  approveButton: {
    flex: 1,
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  approveText: {
    color: colors.bgPrimary,
    fontSize: 14,
    fontFamily: fontFamily.semibold,
    letterSpacing: 0.3,
  },
});
