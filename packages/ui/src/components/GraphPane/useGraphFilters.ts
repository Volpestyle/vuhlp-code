import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { Node, Edge, NodeStatus, Provider } from '../../types';

export interface UseGraphFiltersProps {
  nodes: Node[];
  edges: Edge[];
  runId: string | null;
}

export function useGraphFilters({ nodes, edges, runId }: UseGraphFiltersProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<NodeStatus[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<Provider[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  // Track previous runId to detect changes
  const prevRunIdRef = useRef(runId);

  // Reset filters when run changes
  useEffect(() => {
    if (runId !== prevRunIdRef.current) {
      prevRunIdRef.current = runId;
      setSearchQuery('');
      setSelectedStatuses([]);
      setSelectedProviders([]);
      setShowFilters(false);
    }
  }, [runId]);

  const {
    visibleNodes,
    visibleNodeIds,
    visibleEdgeIds,
  } = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const filteredNodes = nodes.filter((node) => {
      const matchesQuery = query.length === 0
        || node.label.toLowerCase().includes(query)
        || node.id.toLowerCase().includes(query)
        || node.status.toLowerCase().includes(query)
        || (node.providerId ? node.providerId.toLowerCase().includes(query) : false)
        || (node.type ? node.type.toLowerCase().includes(query) : false);

      const matchesStatus = selectedStatuses.length === 0 || selectedStatuses.includes(node.status);
      const matchesProvider = selectedProviders.length === 0 || (node.providerId ? selectedProviders.includes(node.providerId) : false);

      return matchesQuery && matchesStatus && matchesProvider;
    });

    const nodeIdSet = new Set(filteredNodes.map((node) => node.id));
    // Filter edges where both source and target are visible
    const filteredEdges = edges.filter((edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target));
    const edgeIdSet = new Set(filteredEdges.map((edge) => edge.id));

    return {
      visibleNodes: filteredNodes,
      visibleNodeIds: nodeIdSet,
      visibleEdgeIds: edgeIdSet,
    };
  }, [nodes, edges, searchQuery, selectedStatuses, selectedProviders]);

  const hasActiveFilters = searchQuery.trim().length > 0
    || selectedStatuses.length > 0
    || selectedProviders.length > 0;

  const toggleStatusFilter = useCallback((status: NodeStatus) => {
    setSelectedStatuses((prev) => (
      prev.includes(status) ? prev.filter((item) => item !== status) : [...prev, status]
    ));
  }, []);

  const toggleProviderFilter = useCallback((provider: Provider) => {
    setSelectedProviders((prev) => (
      prev.includes(provider) ? prev.filter((item) => item !== provider) : [...prev, provider]
    ));
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setSelectedStatuses([]);
    setSelectedProviders([]);
  }, []);

  return {
    searchQuery,
    setSearchQuery,
    selectedStatuses,
    selectedProviders,
    showFilters,
    setShowFilters,
    visibleNodes,
    visibleNodeIds,
    visibleEdgeIds,
    hasActiveFilters,
    toggleStatusFilter,
    toggleProviderFilter,
    clearFilters,
  };
}
