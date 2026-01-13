import React from 'react';

export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface ResizeHandlesProps {
  onResizeStart: (direction: ResizeDirection, e: React.MouseEvent) => void;
}

/**
 * Resize handles for all 8 directions (4 edges + 4 corners).
 */
export function ResizeHandles({ onResizeStart }: ResizeHandlesProps) {
  const handleMouseDown = (direction: ResizeDirection) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onResizeStart(direction, e);
  };

  return (
    <>
      {/* Edge handles */}
      <div
        className="vuhlp-node-window__resize-handle vuhlp-node-window__resize-handle--n"
        onMouseDown={handleMouseDown('n')}
      />
      <div
        className="vuhlp-node-window__resize-handle vuhlp-node-window__resize-handle--s"
        onMouseDown={handleMouseDown('s')}
      />
      <div
        className="vuhlp-node-window__resize-handle vuhlp-node-window__resize-handle--e"
        onMouseDown={handleMouseDown('e')}
      />
      <div
        className="vuhlp-node-window__resize-handle vuhlp-node-window__resize-handle--w"
        onMouseDown={handleMouseDown('w')}
      />

      {/* Corner handles */}
      <div
        className="vuhlp-node-window__resize-handle vuhlp-node-window__resize-handle--corner vuhlp-node-window__resize-handle--nw"
        onMouseDown={handleMouseDown('nw')}
      />
      <div
        className="vuhlp-node-window__resize-handle vuhlp-node-window__resize-handle--corner vuhlp-node-window__resize-handle--ne"
        onMouseDown={handleMouseDown('ne')}
      />
      <div
        className="vuhlp-node-window__resize-handle vuhlp-node-window__resize-handle--corner vuhlp-node-window__resize-handle--sw"
        onMouseDown={handleMouseDown('sw')}
      />
      <div
        className="vuhlp-node-window__resize-handle vuhlp-node-window__resize-handle--corner vuhlp-node-window__resize-handle--se"
        onMouseDown={handleMouseDown('se')}
      />
    </>
  );
}
