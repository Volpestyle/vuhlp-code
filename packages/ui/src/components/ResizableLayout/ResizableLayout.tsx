import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import './ResizableLayout.css';

export interface ResizableLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  inspector: ReactNode;
  className?: string;
  defaultSidebarWidth?: number;
  defaultInspectorWidth?: number;
  minSidebarWidth?: number;
  maxSidebarWidth?: number;
  minInspectorWidth?: number;
  maxInspectorWidth?: number;
}

const STORAGE_KEY_SIDEBAR = 'vuhlp-sidebar-width';
const STORAGE_KEY_INSPECTOR = 'vuhlp-inspector-width';

export function ResizableLayout({
  sidebar,
  main,
  inspector,
  className = '',
  defaultSidebarWidth = 280,
  defaultInspectorWidth = 400,
  minSidebarWidth = 200,
  maxSidebarWidth = 400,
  minInspectorWidth = 280,
  maxInspectorWidth = 600,
}: ResizableLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') return defaultSidebarWidth;
    const stored = localStorage.getItem(STORAGE_KEY_SIDEBAR);
    return stored ? parseInt(stored, 10) : defaultSidebarWidth;
  });

  const [inspectorWidth, setInspectorWidth] = useState(() => {
    if (typeof window === 'undefined') return defaultInspectorWidth;
    const stored = localStorage.getItem(STORAGE_KEY_INSPECTOR);
    return stored ? parseInt(stored, 10) : defaultInspectorWidth;
  });

  const [dragging, setDragging] = useState<'sidebar' | 'inspector' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Persist widths
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_SIDEBAR, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_INSPECTOR, String(inspectorWidth));
  }, [inspectorWidth]);

  const handleMouseDown = useCallback(
    (panel: 'sidebar' | 'inspector') => (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(panel);
    },
    []
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging || !containerRef.current) return;

      const containerRect = containerRef.current.getBoundingClientRect();

      if (dragging === 'sidebar') {
        const newWidth = e.clientX - containerRect.left;
        setSidebarWidth(Math.max(minSidebarWidth, Math.min(maxSidebarWidth, newWidth)));
      } else if (dragging === 'inspector') {
        const newWidth = containerRect.right - e.clientX;
        setInspectorWidth(Math.max(minInspectorWidth, Math.min(maxInspectorWidth, newWidth)));
      }
    },
    [dragging, minSidebarWidth, maxSidebarWidth, minInspectorWidth, maxInspectorWidth]
  );

  const handleMouseUp = useCallback(() => {
    setDragging(null);
  }, []);

  useEffect(() => {
    if (dragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, handleMouseMove, handleMouseUp]);

  return (
    <div ref={containerRef} className={`vuhlp-layout ${className}`}>
      <div className="vuhlp-layout__sidebar" style={{ width: sidebarWidth }}>
        {sidebar}
      </div>

      <div
        className={`vuhlp-layout__handle ${dragging === 'sidebar' ? 'vuhlp-layout__handle--active' : ''}`}
        onMouseDown={handleMouseDown('sidebar')}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      />

      <div className="vuhlp-layout__main">{main}</div>

      <div
        className={`vuhlp-layout__handle ${dragging === 'inspector' ? 'vuhlp-layout__handle--active' : ''}`}
        onMouseDown={handleMouseDown('inspector')}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
      />

      <div className="vuhlp-layout__inspector" style={{ width: inspectorWidth }}>
        {inspector}
      </div>
    </div>
  );
}
