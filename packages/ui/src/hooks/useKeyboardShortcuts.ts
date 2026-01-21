/**
 * Keyboard shortcuts hook
 * Implements shortcuts from docs/07-ui-spec.md:
 * - f: Toggle fullscreen for selected node
 * - shift+f: Collapse all (overview)
 * - shift+n: New node
 * - shift+d: Duplicate selected node
 * - delete: Delete selected
 * - enter: Start/stop selected node
 */

import { useEffect, useCallback } from 'react';
import { useRunStore } from '../stores/runStore';
import { createNode, deleteEdge, deleteNode, startNodeProcess, stopNodeProcess } from '../lib/api';

export function useKeyboardShortcuts() {
  const viewMode = useRunStore((s) => s.ui.viewMode);
  const selectedNodeId = useRunStore((s) => s.ui.selectedNodeId);
  const selectedEdgeId = useRunStore((s) => s.ui.selectedEdgeId);
  const run = useRunStore((s) => s.run);
  const setViewMode = useRunStore((s) => s.setViewMode);
  const selectNode = useRunStore((s) => s.selectNode);
  const selectEdge = useRunStore((s) => s.selectEdge);
  const removeNode = useRunStore((s) => s.removeNode);
  const removeEdge = useRunStore((s) => s.removeEdge);
  const addNode = useRunStore((s) => s.addNode);
  const duplicateNode = useRunStore((s) => s.duplicateNode);
  const toggleNodeRunning = useRunStore((s) => s.toggleNodeRunning);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs (except Escape to exit focus)
      const target = event.target as HTMLElement;
      const isTypingTarget =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (isTypingTarget && event.key.toLowerCase() !== 'escape') {
        return;
      }

      const key = event.key.toLowerCase();
      const isShift = event.shiftKey;

      // f: Toggle fullscreen for selected node
      if (key === 'f' && !isShift) {
        if (viewMode === 'fullscreen') {
          setViewMode('graph');
        } else if (selectedNodeId) {
          setViewMode('fullscreen');
        }
        event.preventDefault();
        return;
      }

      // shift+f: Collapse all (overview mode)
      if (key === 'f' && isShift) {
        if (viewMode === 'collapsed') {
          setViewMode('graph');
        } else {
          setViewMode('collapsed');
        }
        event.preventDefault();
        return;
      }

      // shift+n: New node
      if (key === 'n' && isShift && run) {
        void createNode(run.id, {
          label: `New Node ${Object.keys(run.nodes).length + 1}`,
          roleTemplate: 'implementer',
          provider: 'claude',
          capabilities: {
            edgeManagement: 'none',
            writeCode: true,
            writeDocs: true,
            runCommands: true,
            delegateOnly: false,
          },
          permissions: {
            cliPermissionsMode: 'skip',
            agentManagementRequiresApproval: true,
          },
          session: {
            resume: true,
            resetCommands: ['/new', '/clear'],
          },
        })
          .then((created) => {
            addNode(created);
            selectNode(created.id);
          })
          .catch((error) => {
            console.error('[shortcuts] failed to create node', error);
          });
        event.preventDefault();
        return;
      }

      // shift+d: Duplicate selected node
      if (key === 'd' && isShift && selectedNodeId) {
        const sourceNode = run?.nodes[selectedNodeId];
        if (run && sourceNode) {
          void createNode(run.id, {
            label: `${sourceNode.label} (copy)`,
            roleTemplate: sourceNode.roleTemplate,
            provider: sourceNode.provider,
            capabilities: sourceNode.capabilities,
            permissions: sourceNode.permissions,
            session: {
              resume: true,
              resetCommands: sourceNode.session.resetCommands,
            },
          })
            .then((created) => {
              addNode(created);
              selectNode(created.id);
            })
            .catch((error) => {
              console.error('[shortcuts] failed to duplicate node', error);
            });
        } else {
          duplicateNode(selectedNodeId);
        }
        event.preventDefault();
        return;
      }

      // delete/backspace: Delete selected edge or node
      if (key === 'delete' || key === 'backspace') {
        if (selectedEdgeId) {
          if (run) {
            void deleteEdge(run.id, selectedEdgeId)
              .then(() => removeEdge(selectedEdgeId))
              .catch((error) => {
                console.error('[shortcuts] failed to delete edge', error);
              });
          } else {
            removeEdge(selectedEdgeId);
          }
          event.preventDefault();
          return;
        }
        if (selectedNodeId) {
          if (run) {
            void deleteNode(run.id, selectedNodeId)
              .then(() => removeNode(selectedNodeId))
              .catch((error) => {
                console.error('[shortcuts] failed to delete node', error);
              });
          } else {
            removeNode(selectedNodeId);
          }
          event.preventDefault();
          return;
        }
      }

      // enter: Start/stop selected node
      if (key === 'enter' && selectedNodeId) {
        const node = run?.nodes[selectedNodeId];
        if (run && node) {
          const connectionStatus = node.connection?.status ?? 'disconnected';
          const action =
            connectionStatus === 'disconnected' ? startNodeProcess : stopNodeProcess;
          void action(run.id, selectedNodeId).catch((error) => {
            console.error('[shortcuts] failed to toggle node process', error);
          });
        } else {
          toggleNodeRunning(selectedNodeId);
        }
        event.preventDefault();
        return;
      }

      // escape: Deselect node/edge or exit fullscreen
      if (key === 'escape') {
        if (viewMode === 'fullscreen') {
          setViewMode('graph');
        } else if (selectedEdgeId) {
          selectEdge(null);
        } else if (selectedNodeId) {
          selectNode(null);
        }
        event.preventDefault();
        return;
      }
    },
    [
      viewMode,
      selectedNodeId,
      selectedEdgeId,
      run,
      setViewMode,
      selectNode,
      selectEdge,
      removeNode,
      removeEdge,
      addNode,
      duplicateNode,
      toggleNodeRunning,
    ]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
