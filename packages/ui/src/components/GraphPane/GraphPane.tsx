import { useEffect, useRef, useCallback, useState } from 'react';
import cytoscape, { type Core, type EventObject } from 'cytoscape';
import type { Run, RunMode, RunPhase, InteractionMode, Node, NodeTrackedState } from '../../types';
import { NodeWindow } from './NodeWindow';
import { useNodeWindowState, clearSavedWindowStates } from './useNodeWindowState';
import {
  Position,
  Size,
  cyToScreen,
  centerToTopLeft,
} from './coordinateUtils';
import './GraphPane.css';

// Storage key prefix for node positions
const POSITION_STORAGE_PREFIX = 'vuhlp-graph-positions-';

// Grid size for snapping
const SNAP_SIZE = 20;

type ConnectionStyle = 'bezier' | 'taxi' | 'straight';

interface NodePosition {
  x: number;
  y: number;
}

interface SavedPositions {
  [nodeId: string]: NodePosition;
}

function getPositionStorageKey(runId: string): string {
  return `${POSITION_STORAGE_PREFIX}${runId}`;
}

function loadSavedPositions(runId: string): SavedPositions | null {
  try {
    const stored = localStorage.getItem(getPositionStorageKey(runId));
    if (stored) {
      return JSON.parse(stored) as SavedPositions;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function savePositions(runId: string, positions: SavedPositions): void {
  try {
    localStorage.setItem(getPositionStorageKey(runId), JSON.stringify(positions));
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

function clearSavedPositions(runId: string): void {
  try {
    localStorage.removeItem(getPositionStorageKey(runId));
  } catch {
    // Ignore storage errors
  }
}

export interface GraphPaneProps {
  run: Run | null;
  onNodeSelect: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  onStop: () => void;
  onPause: () => void;
  onResume: (feedback?: string) => void;
  interactionMode: InteractionMode;
  onInteractionModeChange: (mode: InteractionMode) => void;
  runMode: RunMode;
  onRunModeChange: (mode: RunMode) => void;
  runPhase: RunPhase | null;
  getNodeTrackedState: (runId: string, nodeId: string) => NodeTrackedState;
}

const STATUS_COLORS: Record<string, string> = {
  queued: '#71717a',
  running: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
  skipped: '#64748b',
};

const PROVIDER_COLORS: Record<string, string> = {
  claude: '#f59e0b',
  codex: '#10b981',
  gemini: '#6366f1',
  mock: '#71717a',
};

export function GraphPane({
  run,
  onNodeSelect,
  selectedNodeId,
  onStop,
  onPause,
  onResume,
  interactionMode: _interactionMode,
  onInteractionModeChange: _onInteractionModeChange,
  runMode,
  onRunModeChange,
  runPhase,
  getNodeTrackedState,
}: GraphPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const runIdRef = useRef<string | null>(null);
  const firstLoadRef = useRef<boolean>(true);
  const syncRef = useRef<number | null>(null);

  // Viewport state for coordinate transformations
  const [viewport, setViewport] = useState({ zoom: 1, pan: { x: 0, y: 0 } });
  
  // Graph visual settings
  const [connectionStyle, setConnectionStyle] = useState<ConnectionStyle>('bezier');
  const [searchQuery, setSearchQuery] = useState('');

  // Node positions from Cytoscape (model coordinates)
  const [nodePositions, setNodePositions] = useState<Record<string, Position>>({});

  // Window sizes
  const { getWindowSize, updateWindowSize, resetWindowSizes } = useNodeWindowState(run?.id || null);

  // Update node positions from Cytoscape
  const syncPositionsFromCy = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const positions: Record<string, Position> = {};
    cy.nodes().forEach((node) => {
      const pos = node.position();
      positions[node.id()] = { x: pos.x, y: pos.y };
    });
    setNodePositions(positions);

    // Also update viewport
    const currentPan = (cy as unknown as { pan(): { x: number; y: number } }).pan();
    setViewport({
      zoom: cy.zoom(),
      pan: currentPan,
    });
  }, []);

  // Throttled sync for high-frequency events
  const throttledSync = useCallback(() => {
    if (syncRef.current) return;
    syncRef.current = requestAnimationFrame(() => {
        syncPositionsFromCy();
        syncRef.current = null;
    });
  }, [syncPositionsFromCy]);

  // Initialize Cytoscape
  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      autoungrabify: true, // Disable node dragging in Cytoscape (we handle it in HTML)
      autounselectify: true,
      userPanningEnabled: true,
      userZoomingEnabled: true,
      style: [
        {
          // Nodes serve as invisible anchors with correct dimensions for edge routing
          selector: 'node',
          style: {
            'background-opacity': 0,
            'border-width': 0,
            width: 'data(width)',
            height: 'data(height)',
            shape: 'round-rectangle',
            label: '',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': '#52525b',
            'target-arrow-color': '#52525b',
            'target-arrow-shape': 'triangle',
            'curve-style': connectionStyle,
            'taxi-direction': 'horizontal',
            'taxi-turn': 20,
            'arrow-scale': 1,
            'font-size': 10,
            'color': '#71717a',
            'text-rotation': 'autorotate',
            'text-background-color': '#18181b',
            'text-background-opacity': 1,
            'text-background-padding': 2,
          } as any, 
        },
        // Edge Semantic Styling
        {
          selector: 'edge[type="handoff"]',
          style: {
            'line-style': 'dashed',
            'line-color': '#71717a',
            'target-arrow-color': '#71717a',
            label: 'handoff',
          },
        },
        {
          selector: 'edge[type="report"]',
          style: {
            'line-style': 'dotted',
            'line-color': '#71717a',
            'target-arrow-color': '#71717a',
            label: 'report',
          },
        },
        {
          selector: 'edge[type="gate"]',
          style: {
            'line-color': '#f59e0b',
            'target-arrow-color': '#f59e0b',
            label: 'gate',
          },
        },
        {
            selector: 'edge[type="dependency"]',
            style: {
                label: '',
            }
        },
        // Selection/Focus Styling
        {
            selector: '.dimmed',
            style: {
                'opacity': 0.1
            }
        },
        {
            selector: 'edge.highlighted',
            style: {
                'line-color': '#3b82f6',
                'target-arrow-color': '#3b82f6',
                'width': 3,
                'z-index': 10,
                'opacity': 1
            }
        }
      ],
      layout: {
        name: 'breadthfirst',
        directed: true,
        padding: 200,
        spacingFactor: 2.5,
      },
      minZoom: 0.2,
      maxZoom: 2,
      wheelSensitivity: 0.3,
    });

    // Click on canvas to deselect
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        onNodeSelect(null);
      }
    });

    // Sync positions when viewport changes (throttled)
    cy.on('pan zoom render', throttledSync);

    cyRef.current = cy;

    return () => {
      if (syncRef.current) cancelAnimationFrame(syncRef.current);
      cy.destroy();
    };
  }, [onNodeSelect, throttledSync, connectionStyle]);

  // Update styles when connection style changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    
    (cy as any).style()
      .selector('edge')
      .style({
        'curve-style': connectionStyle,
      } as any)
      .update();
  }, [connectionStyle]);

  // Handle Selection Focus & Search Filter
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
        cy.elements().removeClass('dimmed');
        cy.edges().removeClass('highlighted');

        const hasSearch = searchQuery.trim().length > 0;
        const hasSelection = !!selectedNodeId;
        
        if (!hasSearch && !hasSelection) return;
        
        // Start with all dimmed
        cy.elements().addClass('dimmed');
        
        if (hasSelection) {
            const selected = cy.getElementById(selectedNodeId) as any;
            if (selected.nonempty()) {
                selected.removeClass('dimmed');
                selected.neighborhood().removeClass('dimmed');
                selected.connectedEdges().addClass('highlighted');
            }
        }
        
        if (hasSearch) {
             const query = searchQuery.toLowerCase();
             const matches = cy.nodes().filter((n: any) => {
                 const nodeData = run?.nodes?.[n.id()];
                 if (!nodeData) return false;
                 
                 return !!(
                     (nodeData.label && nodeData.label.toLowerCase().includes(query)) ||
                     nodeData.id.toLowerCase().includes(query) ||
                     (nodeData.status && nodeData.status.toLowerCase().includes(query)) ||
                     (nodeData.providerId && nodeData.providerId.toLowerCase().includes(query)) ||
                     (nodeData.type && nodeData.type.toLowerCase().includes(query))
                 );
             });
             
             matches.removeClass('dimmed');
             // Also un-dim edges between two matched nodes
             matches.connectedEdges().filter((e: any) => {
                 return matches.contains(e.source()) && matches.contains(e.target());
             }).removeClass('dimmed');
        }
    });
  }, [selectedNodeId, searchQuery, run]);

  // Update graph when run changes (Incremental)
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    if (!run?.nodes) {
      cy.elements().remove();
      runIdRef.current = null;
      setNodePositions({});
      firstLoadRef.current = true;
      return;
    }

    // Detect new run
    if (runIdRef.current !== run.id) {
        runIdRef.current = run.id;
        firstLoadRef.current = true;
        cy.elements().remove();
    }

    const currentRunId = run.id;

    // Load saved positions if this is a fresh start
    let mergedPositions: SavedPositions = {};
    if (firstLoadRef.current) {
        mergedPositions = loadSavedPositions(currentRunId) || {};
    }

    cy.batch(() => {
        const existingNodes = new Set(cy.nodes().map((n: any) => n.id()));
        const existingEdges = new Set(cy.edges().map((e: any) => e.id()));
        
        const newNodes = run.nodes ? Object.values(run.nodes) : [];
        const newEdges = run.edges ? Object.values(run.edges) : [];

        // 1. Remove obsolete elements
        const newNodeIds = new Set(newNodes.map(n => n.id));
        const newEdgeIds = new Set(newEdges.map(e => e.id));

        const nodesToRemove = [...existingNodes].filter(id => !newNodeIds.has(id));
        const edgesToRemove = [...existingEdges].filter(id => !newEdgeIds.has(id));

        if (nodesToRemove.length) cy.remove(nodesToRemove.map(id => `#${id}`).join(','));
        if (edgesToRemove.length) cy.remove(edgesToRemove.map(id => `#${id}`).join(','));

        // 2. Add new nodes
        const nodesToAdd = newNodes
            .filter(n => !existingNodes.has(n.id))
            .map(node => {
                const savedPos = mergedPositions[node.id];
                const size = getWindowSize(node.id);
                return {
                    data: {
                        id: node.id,
                        width: size.width,
                        height: size.height,
                    },
                    ...(savedPos ? { position: savedPos } : {}),
                    grabbable: false,
                };
            });
            
        if (nodesToAdd.length) cy.add(nodesToAdd);

        // 3. Add new edges
        const edgesToAdd = newEdges
            .filter(e => !existingEdges.has(e.id))
            .map(edge => ({
                data: {
                    id: edge.id,
                    source: edge.source,
                    target: edge.target,
                    type: edge.type,
                },
            }));

        if (edgesToAdd.length) cy.add(edgesToAdd);
    });

    // 4. Layout & Fit logic
    if (firstLoadRef.current) {
         const allNodesHavePositions = Object.values(run.nodes).every(n => mergedPositions[n.id]);
         
         if (!allNodesHavePositions) {
             cy.layout({
                name: 'breadthfirst',
                directed: true,
                padding: 200,
                spacingFactor: 2.5,
              }).run();
         }
         
         cy.fit(undefined, 100);
         firstLoadRef.current = false;
         
         setTimeout(() => syncPositionsFromCy(), 50);
    } 

    syncPositionsFromCy();
  }, [run, syncPositionsFromCy, getWindowSize]);

  // Handle window position change (from drag)
  const handlePositionChange = useCallback((nodeId: string, deltaX: number, deltaY: number) => {
    const cy = cyRef.current;
    if (!cy) return;

    let updated = false;
    cy.nodes().forEach((node) => {
      if (node.id() === nodeId && !updated) {
        updated = true;
        const zoom = cy.zoom();
        const modelDeltaX = deltaX / zoom;
        const modelDeltaY = deltaY / zoom;
        const currentPos = node.position();
        let newX = currentPos.x + modelDeltaX;
        let newY = currentPos.y + modelDeltaY;
        newX = Math.round(newX / SNAP_SIZE) * SNAP_SIZE;
        newY = Math.round(newY / SNAP_SIZE) * SNAP_SIZE;
        (node as unknown as { position(pos: { x: number; y: number }): void }).position({
          x: newX,
          y: newY,
        });
      }
    });

    if (!updated) return;

    const runId = runIdRef.current;
    if (runId) {
      const positions: SavedPositions = {};
      cy.nodes().forEach((n) => {
        const pos = n.position();
        positions[n.id()] = { x: pos.x, y: pos.y };
      });
      savePositions(runId, positions);
    }

    throttledSync();
  }, [throttledSync]);

  // Handle window size change
  const handleSizeChange = useCallback((nodeId: string, size: Size) => {
    updateWindowSize(nodeId, size);
    const cy = cyRef.current;
    if (cy) {
      const node = cy.getElementById(nodeId);
      if (node) {
        (node as any).data({
          width: size.width,
          height: size.height
        });
      }
    }
  }, [updateWindowSize]);

  // Handle window select
  const handleWindowSelect = useCallback((nodeId: string) => {
    onNodeSelect(nodeId);
  }, [onNodeSelect]);

  const handleZoomIn = useCallback(() => {
    cyRef.current?.zoom(cyRef.current.zoom() * 1.2);
  }, []);

  const handleZoomOut = useCallback(() => {
    cyRef.current?.zoom(cyRef.current.zoom() / 1.2);
  }, []);

  const handleFit = useCallback(() => {
    cyRef.current?.fit(undefined, 100);
  }, []);
  
  const handleCenterSelection = useCallback(() => {
      if (selectedNodeId) {
          cyRef.current?.fit(cyRef.current.getElementById(selectedNodeId), 50);
      }
  }, [selectedNodeId]);

  const handleResetLayout = useCallback(() => {
    const cy = cyRef.current;
    const runId = runIdRef.current;
    if (!cy || !runId) return;

    clearSavedPositions(runId);
    clearSavedWindowStates(runId);
    resetWindowSizes();

    cy.layout({
      name: 'breadthfirst',
      directed: true,
      padding: 200,
      spacingFactor: 2.5,
    }).run();

    cy.fit(undefined, 100);

    setTimeout(() => {
      syncPositionsFromCy();
    }, 50);
  }, [resetWindowSizes, syncPositionsFromCy]);

  const isRunning = run?.status === 'running';
  const isPaused = run?.status === 'paused';
  const canControl = isRunning || isPaused;

  const getScreenPosition = useCallback((nodeId: string, scaledSize: Size): Position => {
    const modelPos = nodePositions[nodeId];
    if (!modelPos) return { x: 0, y: 0 };
    const screenCenter = cyToScreen(modelPos, viewport);
    return centerToTopLeft(screenCenter, scaledSize);
  }, [nodePositions, viewport]);

  const getScaledSize = useCallback((nodeId: string): Size => {
    const baseSize = getWindowSize(nodeId);
    return {
      width: baseSize.width * viewport.zoom,
      height: baseSize.height * viewport.zoom,
    };
  }, [getWindowSize, viewport.zoom]);

  return (
    <div className="vuhlp-graph">
      {/* Toolbar */}
      <div className="vuhlp-graph__toolbar">
        <div className="vuhlp-graph__info">
          {run ? (
            <>
              <span className={`vuhlp-graph__status vuhlp-graph__status--${run.status}`}>
                {run.status}
              </span>
              {runPhase && (
                <span className="vuhlp-graph__phase">{runPhase}</span>
              )}
            </>
          ) : (
            <span className="vuhlp-graph__empty-hint">Select a session to view graph</span>
          )}
        </div>

        <div className="vuhlp-graph__controls">
          {/* Search */}
          <div className="vuhlp-graph__search">
             <input 
                 type="text"
                 placeholder="Search nodes..."
                 value={searchQuery}
                 onChange={(e) => setSearchQuery(e.target.value)}
                 className="vuhlp-graph__search-input"
             />
             {searchQuery && (
                 <button className="vuhlp-graph__search-clear" onClick={() => setSearchQuery('')}>×</button>
             )}
          </div>

          <div className="vuhlp-graph__style-select">
            <select 
              value={connectionStyle}
              onChange={(e) => setConnectionStyle(e.target.value as ConnectionStyle)}
              className="vuhlp-graph__select"
            >
              <option value="bezier">Bezier</option>
              <option value="taxi">Taxi</option>
              <option value="straight">Straight</option>
            </select>
          </div>

          {/* Mode Toggle */}
          {run && (
            <div className="vuhlp-graph__mode-toggle">
              <button
                className={`vuhlp-graph__mode-btn ${runMode === 'AUTO' ? 'vuhlp-graph__mode-btn--active' : ''}`}
                onClick={() => onRunModeChange('AUTO')}
              >
                Auto
              </button>
              <button
                className={`vuhlp-graph__mode-btn ${runMode === 'INTERACTIVE' ? 'vuhlp-graph__mode-btn--active' : ''}`}
                onClick={() => onRunModeChange('INTERACTIVE')}
              >
                Interactive
              </button>
            </div>
          )}

          {/* Run Controls */}
          {canControl && (
            <div className="vuhlp-graph__run-controls">
              {isRunning && (
                <button
                  className="vuhlp-graph__control-btn vuhlp-graph__control-btn--pause"
                  onClick={onPause}
                  title="Pause"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <rect x="3" y="2" width="4" height="12" rx="1" />
                    <rect x="9" y="2" width="4" height="12" rx="1" />
                  </svg>
                </button>
              )}
              {isPaused && (
                <button
                  className="vuhlp-graph__control-btn vuhlp-graph__control-btn--resume"
                  onClick={() => onResume()}
                  title="Resume"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 2.5a.5.5 0 0 1 .8-.4l8 6a.5.5 0 0 1 0 .8l-8 6a.5.5 0 0 1-.8-.4v-12z" />
                  </svg>
                </button>
              )}
              <button
                className="vuhlp-graph__control-btn vuhlp-graph__control-btn--stop"
                onClick={onStop}
                title="Stop"
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                </svg>
              </button>
            </div>
          )}

          {/* Zoom Controls */}
          <div className="vuhlp-graph__zoom-controls">
            <span className="vuhlp-graph__zoom-level" title="Current zoom level">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="7" r="4" />
                <path d="M10 10l3 3" strokeLinecap="round" />
              </svg>
              {Math.round(viewport.zoom * 100)}%
            </span>
            <button className="vuhlp-graph__zoom-btn" onClick={handleZoomOut} title="Zoom out">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 8h8" strokeLinecap="round" />
              </svg>
            </button>
            <button className="vuhlp-graph__zoom-btn" onClick={handleFit} title="Fit to view">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="2" width="12" height="12" rx="1" />
                <path d="M5 8h6M8 5v6" strokeLinecap="round" />
              </svg>
            </button>
             {selectedNodeId && (
                 <button className="vuhlp-graph__zoom-btn" onClick={handleCenterSelection} title="Center selection">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M8 8m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
                        <path d="M8 2v2M8 12v2M2 8h2M12 8h2" />
                    </svg>
                 </button>
             )}
            <button className="vuhlp-graph__zoom-btn" onClick={handleZoomIn} title="Zoom in">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 8h8M8 4v8" strokeLinecap="round" />
              </svg>
            </button>
            {run && (
              <button className="vuhlp-graph__zoom-btn" onClick={handleResetLayout} title="Reset layout">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Graph Container - Canvas for edges */}
      <div className="vuhlp-graph__canvas-container">
        <div ref={containerRef} className="vuhlp-graph__canvas" />

        {/* Windows Layer - HTML nodes on top of canvas */}
        {run && run.nodes && (
          <div className="vuhlp-graph__windows-layer">
            {Object.values(run.nodes).map((node: Node) => {
              const scaledSize = getScaledSize(node.id);
              const screenPos = getScreenPosition(node.id, scaledSize);
              const trackedState = getNodeTrackedState(run.id, node.id);

              return (
                <NodeWindow
                  key={node.id}
                  node={node}
                  trackedState={trackedState}
                  screenPosition={screenPos}
                  size={scaledSize}
                  isSelected={selectedNodeId === node.id}
                  onPositionChange={handlePositionChange}
                  onSizeChange={handleSizeChange}
                  onSelect={handleWindowSelect}
                  zoom={viewport.zoom}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Empty State */}
      {!run && (
        <div className="vuhlp-graph__empty">
          <div className="vuhlp-graph__empty-icon">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="4" />
              <circle cx="36" cy="12" r="4" />
              <circle cx="24" cy="36" r="4" />
              <path d="M15 14l6 18M33 14l-6 18" strokeLinecap="round" />
            </svg>
          </div>
          <p>Create a session to start orchestration</p>
        </div>
      )}

      {/* Legend */}
      {run && (
        <div className="vuhlp-graph__legend">
          <div className="vuhlp-graph__legend-section">
            <span className="vuhlp-graph__legend-title">Status</span>
            <div className="vuhlp-graph__legend-items">
              <span className="vuhlp-graph__legend-item">
                <span className="vuhlp-graph__legend-dot" style={{ background: STATUS_COLORS.queued }} />
                Queued
              </span>
              <span className="vuhlp-graph__legend-item">
                <span className="vuhlp-graph__legend-dot vuhlp-graph__legend-dot--pulse" style={{ background: STATUS_COLORS.running }} />
                Running
              </span>
              <span className="vuhlp-graph__legend-item">
                <span className="vuhlp-graph__legend-dot" style={{ background: STATUS_COLORS.completed }} />
                Done
              </span>
              <span className="vuhlp-graph__legend-item">
                <span className="vuhlp-graph__legend-dot" style={{ background: STATUS_COLORS.failed }} />
                Failed
              </span>
            </div>
          </div>
          <div className="vuhlp-graph__legend-section">
            <span className="vuhlp-graph__legend-title">Provider</span>
            <div className="vuhlp-graph__legend-items">
              <span className="vuhlp-graph__legend-item">
                <span className="vuhlp-graph__legend-dot" style={{ background: PROVIDER_COLORS.claude }} />
                Claude
              </span>
              <span className="vuhlp-graph__legend-item">
                <span className="vuhlp-graph__legend-dot" style={{ background: PROVIDER_COLORS.codex }} />
                Codex
              </span>
              <span className="vuhlp-graph__legend-item">
                <span className="vuhlp-graph__legend-dot" style={{ background: PROVIDER_COLORS.gemini }} />
                Gemini
              </span>
            </div>
          </div>
          <div className="vuhlp-graph__legend-section">
             <span className="vuhlp-graph__legend-title">Connections</span>
             <div className="vuhlp-graph__legend-items">
                 <span className="vuhlp-graph__legend-item">
                     <span className="vuhlp-graph__legend-line" style={{ borderTop: '2px solid #71717a' }}></span>
                     Dep
                 </span>
                 <span className="vuhlp-graph__legend-item">
                     <span className="vuhlp-graph__legend-line" style={{ borderTop: '2px dashed #71717a' }}></span>
                     Handoff
                 </span>
                 <span className="vuhlp-graph__legend-item">
                     <span className="vuhlp-graph__legend-line" style={{ borderTop: '2px solid #f59e0b' }}></span>
                     Gate
                 </span>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
