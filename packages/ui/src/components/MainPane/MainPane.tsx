import type { Run, InteractionMode, RunMode, RunPhase, NodeTrackedState } from '../../types';
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
  onStop: () => void;
  onPause: () => void;
  onResume: (feedback?: string) => void;
  interactionMode: InteractionMode;
  onInteractionModeChange: (mode: InteractionMode) => void;
  runMode: RunMode;
  onRunModeChange: (mode: RunMode) => void;
  runPhase: RunPhase | null;
  getNodeTrackedState: (runId: string, nodeId: string) => NodeTrackedState;
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
  onStop,
  onPause,
  onResume,
  interactionMode,
  onInteractionModeChange,
  runMode,
  onRunModeChange,
  runPhase,
  getNodeTrackedState,
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
            onStop={onStop}
            onPause={onPause}
            onResume={onResume}
            interactionMode={interactionMode}
            onInteractionModeChange={onInteractionModeChange}
            runMode={runMode}
            onRunModeChange={onRunModeChange}
            runPhase={runPhase}
            getNodeTrackedState={getNodeTrackedState}
          />
        )}
        {activeTab?.type === 'file' && (
          <FileViewer filePath={activeTab.path} content={activeTab.content} />
        )}
      </div>
    </div>
  );
}
