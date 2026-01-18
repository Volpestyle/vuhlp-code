import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import type { RunState } from '@vuhlp/contracts';
import { api } from '@/lib/api';

export default function RunsScreen() {
  const router = useRouter();
  const [runs, setRuns] = useState<RunState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listRuns()
      .then(setRuns)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#666" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
        <Text style={styles.hint}>Check that the daemon is running</Text>
      </View>
    );
  }

  if (runs.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>No runs yet</Text>
        <Text style={styles.hint}>Create a run from the web UI to get started</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={runs}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <Pressable
          style={styles.card}
          onPress={() => router.push(`/run/${item.id}`)}
        >
          <View style={styles.cardHeader}>
            <View style={[styles.statusDot, statusStyles[item.status]]} />
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.id.slice(0, 8)}
            </Text>
          </View>
          <Text style={styles.cardMeta}>
            {Object.keys(item.nodes).length} nodes · {item.status}
          </Text>
          <Text style={styles.cardDate}>
            {new Date(item.updatedAt).toLocaleString()}
          </Text>
        </Pressable>
      )}
    />
  );
}

const statusStyles: Record<string, object> = {
  running: { backgroundColor: '#22c55e' },
  paused: { backgroundColor: '#eab308' },
  completed: { backgroundColor: '#3b82f6' },
  failed: { backgroundColor: '#ef4444' },
  queued: { backgroundColor: '#6b7280' },
};

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  error: {
    color: '#ef4444',
    fontSize: 16,
    textAlign: 'center',
  },
  empty: {
    color: '#888',
    fontSize: 18,
  },
  hint: {
    color: '#555',
    fontSize: 14,
    marginTop: 8,
  },
  list: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cardTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  cardMeta: {
    color: '#888',
    fontSize: 14,
  },
  cardDate: {
    color: '#555',
    fontSize: 12,
    marginTop: 4,
  },
});
