import type { Run, InteractionMode, RunMode, GlobalMode, RunPhase, NodeTrackedState } from '../../types';
import { GraphPane } from '../GraphPane';
import { FileViewer } from '../FileViewer';
import './MainPane.css';

export type MainTab =
  | { type: 'graph' }
  | { type: 'file'; path: string; content: string };

export interface MainPaneProps {
  // GraphPane props
  run: Run | null;
  onNodeSelect: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  onEdgeUpdate?: (edgeId: string, updates: { source?: string; target?: string }) => void;
  onEdgeCreate?: (sourceId: string, targetId: string) => void;
  onEdgeDelete?: (edgeId: string) => void;
  onNodeCreate?: (providerId: string, label: string) => void;
  onNodeDelete?: (nodeId: string) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: (feedback?: string) => void;
  interactionMode: InteractionMode;
  onInteractionModeChange: (mode: InteractionMode) => void;
  runMode: RunMode;
  onRunModeChange: (mode: RunMode) => void;
  globalMode: GlobalMode;
  onGlobalModeChange: (mode: GlobalMode) => void;
  skipCliPermissions: boolean;
  onSkipCliPermissionsChange: (skip: boolean) => void;
  runPhase: RunPhase | null;
  getNodeTrackedState: (runId: string, nodeId: string) => NodeTrackedState;
  onNodeMessage?: (nodeId: string, content: string) => void;
  onStopNode?: (nodeId: string) => void;
  // Tab management props
  openTabs: MainTab[];
  activeTabIndex: number;
  onTabChange: (index: number) => void;
  onCloseTab: (index: number) => void;
}

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

export function MainPane({
  run,
  onNodeSelect,
  selectedNodeId,
  onEdgeUpdate,
  onEdgeCreate,
  onEdgeDelete,
  onNodeCreate,
  onNodeDelete,
  onStop,
  onPause,
  onResume,
  interactionMode,
  onInteractionModeChange,
  runMode,
  onRunModeChange,
  globalMode,
  onGlobalModeChange,
  skipCliPermissions,
  onSkipCliPermissionsChange,
  runPhase,
  getNodeTrackedState,
  onNodeMessage,
  onStopNode,
  openTabs,
  activeTabIndex,
  onTabChange,
  onCloseTab,
}: MainPaneProps) {
  const activeTab = openTabs[activeTabIndex];

  return (
    <div className="vuhlp-main-pane">
      {/* Tab bar - only show if there are file tabs open */}
      {openTabs.length > 1 && (
        <div className="vuhlp-main-pane__tabs">
          {openTabs.map((tab, index) => (
            <button
              key={tab.type === 'graph' ? 'graph' : tab.path}
              className={`vuhlp-main-pane__tab ${index === activeTabIndex ? 'vuhlp-main-pane__tab--active' : ''}`}
              onClick={() => onTabChange(index)}
            >
              <span className="vuhlp-main-pane__tab-label">
                {tab.type === 'graph' ? 'Graph' : getFileName(tab.path)}
              </span>
              {tab.type === 'file' && (
                <button
                  className="vuhlp-main-pane__tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(index);
                  }}
                  title="Close tab"
                >
                  ×
                </button>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      <div className="vuhlp-main-pane__content">
        {activeTab?.type === 'graph' && (
          <GraphPane
            run={run}
            onNodeSelect={onNodeSelect}
            selectedNodeId={selectedNodeId}
            onEdgeUpdate={onEdgeUpdate}
            onEdgeCreate={onEdgeCreate}
            onEdgeDelete={onEdgeDelete}
            onNodeCreate={onNodeCreate}
            onNodeDelete={onNodeDelete}
            onStop={onStop}
            onPause={onPause}
            onResume={onResume}
            interactionMode={interactionMode}
            onInteractionModeChange={onInteractionModeChange}
            runMode={runMode}
            onRunModeChange={onRunModeChange}
            globalMode={globalMode}
            onGlobalModeChange={onGlobalModeChange}
            skipCliPermissions={skipCliPermissions}
            onSkipCliPermissionsChange={onSkipCliPermissionsChange}
            runPhase={runPhase}
            getNodeTrackedState={getNodeTrackedState}
            onNodeMessage={onNodeMessage}
            onStopNode={onStopNode}
          />
        )}
        {activeTab?.type === 'file' && (
          <FileViewer filePath={activeTab.path} content={activeTab.content} />
        )}
      </div>
    </div>
  );
}
