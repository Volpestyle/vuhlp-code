import React, { useCallback, useState, useMemo } from 'react';
import { VisualNode, VisualEdge } from '../../types/graph';
import * as PIXI from 'pixi.js';
import { useRunStore } from '../../stores/runStore';

interface GraphEdgeProps {
  edge: VisualEdge;
  sourceNode: VisualNode;
  targetNode: VisualNode;
  onSelect?: (edgeId: string) => void;
  onContextMenu?: (edgeId: string, event: PIXI.FederatedPointerEvent) => void;
}

interface Port {
  x: number;
  y: number;
  normal: { x: number; y: number };
}

// Helper to get port positions with normals
const getPorts = (node: VisualNode): Port[] => {
  const { x, y } = node.position;
  const { width, height } = node.dimensions;
  return [
    { x: x + width / 2, y: y, normal: { x: 0, y: -1 } },          // Top (Up)
    { x: x + width, y: y + height / 2, normal: { x: 1, y: 0 } },  // Right (Right)
    { x: x + width / 2, y: y + height, normal: { x: 0, y: 1 } },  // Bottom (Down)
    { x: x, y: y + height / 2, normal: { x: -1, y: 0 } }          // Left (Left)
  ];
};

const getDistance = (p1: {x:number, y:number}, p2: {x:number, y:number}) => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

export const GraphEdge: React.FC<GraphEdgeProps> = ({ edge, sourceNode, targetNode, onSelect, onContextMenu }) => {
  const handlePointerDown = useCallback(
    (event: PIXI.FederatedPointerEvent) => {
      event.stopPropagation();
      const isContextClick = event.button === 2 || (event.button === 0 && event.ctrlKey);
      if (isContextClick) {
        onContextMenu?.(edge.id, event);
        return;
      }
      onSelect?.(edge.id);
    },
    [edge.id, onContextMenu, onSelect]
  );
  
  const lastHandoff = useRunStore((s) => s.ui.lastHandoffs?.[edge.id]);
  const [animationProgress, setAnimationProgress] = useState<number | null>(null);

  // Calculate geometry synchronously to ensure label position is frame-perfect
  const geometry = useMemo(() => {
    if (!sourceNode || !targetNode) return null;

    const sourcePorts = getPorts(sourceNode);
    const targetPorts = getPorts(targetNode);

    // Find shortest connection
    let minDist = Infinity;
    let start = sourcePorts[0];
    let end = targetPorts[0];

    for (const sp of sourcePorts) {
      for (const tp of targetPorts) {
        const d = getDistance(sp, tp);
        if (d < minDist) {
          minDist = d;
          start = sp;
          end = tp;
        }
      }
    }

    const dist = getDistance(start, end);
    // Control point offset based on distance, clamped
    const offset = Math.min(dist * 0.5, 150); 

    const cp1 = {
      x: start.x + start.normal.x * offset,
      y: start.y + start.normal.y * offset
    };
    
    const cp2 = {
      x: end.x + end.normal.x * offset,
      y: end.y + end.normal.y * offset
    };

    // Use geometric midpoint for label - more visually centered than Bezier t=0.5
    const labelX = (start.x + end.x) / 2;
    const labelY = (start.y + end.y) / 2;

    return { start, end, cp1, cp2, labelX, labelY };
  }, [sourceNode, targetNode]);

  PIXI.Ticker.shared.add((_ticker) => {
    if (!lastHandoff) {
      if (animationProgress !== null) setAnimationProgress(null);
      return;
    }
    const now = Date.now();
    const elapsed = now - lastHandoff.timestamp;
    const duration = 2000; // 2 seconds
    
    if (elapsed < duration) {
      setAnimationProgress(elapsed / duration);
    } else if (animationProgress !== null) {
      setAnimationProgress(null);
    }
  });

  const draw = useCallback((g: PIXI.Graphics) => {
    if (!geometry) return;
    const { start, end, cp1, cp2 } = geometry;

    g.clear();
    
    // Main Line
    const lineColor = edge.selected ? 0x007bff : 0x999999;
    const lineAlpha = edge.selected ? 0.95 : 0.8;
    const lineWidth = edge.selected ? 3 : 2;

    g.moveTo(start.x, start.y);
    g.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
    g.stroke({ width: lineWidth, color: lineColor, alpha: lineAlpha });
    
    const arrowLength = 10;
    const arrowWidth = 4;

    // End Arrow Head
    {
      const dx = end.x - cp2.x;
      const dy = end.y - cp2.y;
      const angle = Math.atan2(dy, dx);
      
      const tip = { x: end.x, y: end.y };
      const left = {
        x: end.x - arrowLength * Math.cos(angle) + arrowWidth * Math.sin(angle),
        y: end.y - arrowLength * Math.sin(angle) - arrowWidth * Math.cos(angle)
      };
      const right = {
        x: end.x - arrowLength * Math.cos(angle) - arrowWidth * Math.sin(angle),
        y: end.y - arrowLength * Math.sin(angle) + arrowWidth * Math.cos(angle)
      };
      
      g.poly([tip.x, tip.y, left.x, left.y, right.x, right.y]);
      g.fill({ color: lineColor });
    }

    // Start Arrow Head (if bidirectional)
    if (edge.bidirectional) {
      const dx = start.x - cp1.x; // Vector pointing towards start
      const dy = start.y - cp1.y;
      const angle = Math.atan2(dy, dx);

      const tip = { x: start.x, y: start.y };
       const left = {
        x: start.x - arrowLength * Math.cos(angle) + arrowWidth * Math.sin(angle),
        y: start.y - arrowLength * Math.sin(angle) - arrowWidth * Math.cos(angle)
      };
      const right = {
        x: start.x - arrowLength * Math.cos(angle) - arrowWidth * Math.sin(angle),
        y: start.y - arrowLength * Math.sin(angle) + arrowWidth * Math.cos(angle)
      };
      g.poly([tip.x, tip.y, left.x, left.y, right.x, right.y]);
      g.fill({ color: lineColor });
    }

    // Handoff Animation
    if (animationProgress !== null && lastHandoff && targetNode) {
      // Determine direction: if sender is my targetNode, we reverse
      const isReverse = lastHandoff.fromNodeId === targetNode.id;
      const t = isReverse ? 1 - animationProgress : animationProgress;
      
      const packetX = Math.pow(1 - t, 3) * start.x + 
                   3 * Math.pow(1 - t, 2) * t * cp1.x + 
                   3 * (1 - t) * Math.pow(t, 2) * cp2.x + 
                   Math.pow(t, 3) * end.x;
      const packetY = Math.pow(1 - t, 3) * start.y +
                   3 * Math.pow(1 - t, 2) * t * cp1.y +
                   3 * (1 - t) * Math.pow(t, 2) * cp2.y +
                   Math.pow(t, 3) * end.y;

      // Glow (Outer)
      g.circle(packetX, packetY, 8);
      g.fill({ color: 0x4287f5, alpha: 0.4 });

      // Core (Inner)
      g.circle(packetX, packetY, 4);
      g.fill({ color: 0xffffff, alpha: 1 });
    }

    const hitPadding = 12;
    const minX = Math.min(start.x, end.x, cp1.x, cp2.x);
    const maxX = Math.max(start.x, end.x, cp1.x, cp2.x);
    const minY = Math.min(start.y, end.y, cp1.y, cp2.y);
    const maxY = Math.max(start.y, end.y, cp1.y, cp2.y);
    g.hitArea = new PIXI.Rectangle(
      minX - hitPadding,
      minY - hitPadding,
      maxX - minX + hitPadding * 2,
      maxY - minY + hitPadding * 2
    );
  }, [geometry, edge, animationProgress, lastHandoff, targetNode]);

  if (!geometry) return null;

  return (
    <pixiContainer>
      <pixiGraphics draw={draw} eventMode="static" cursor="pointer" onPointerDown={handlePointerDown} />
      <pixiText
        text={edge.label}
        x={geometry.labelX}
        y={geometry.labelY}
        anchor={0.5}
        resolution={Math.max(2, window.devicePixelRatio)}
        style={new PIXI.TextStyle({
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif',
          fontSize: 12,
          fontWeight: '500',
          fill: edge.selected ? 0x007bff : 0xaaaaaa,
          align: 'center',
          stroke: { color: 0x1a1a1a, width: 3 },
          letterSpacing: 0.3
        })}
        eventMode="none"
      />
    </pixiContainer>
  );
};
