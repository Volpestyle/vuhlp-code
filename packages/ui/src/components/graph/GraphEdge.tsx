import React, { useCallback, useState } from 'react';
import { Graphics, Container, Text } from '@pixi/react';
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
  const [labelPos, setLabelPos] = useState({ x: 0, y: 0 });

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

  PIXI.Ticker.shared.add((_ticker) => {
    if (!lastHandoff) {
      if (animationProgress !== null) setAnimationProgress(null);
      return;
    }
    const now = Date.now();
    const elapsed = now - lastHandoff;
    const duration = 2000; // 2 seconds
    
    if (elapsed < duration) {
      setAnimationProgress(elapsed / duration);
    } else if (animationProgress !== null) {
      setAnimationProgress(null);
    }
  });

  const draw = useCallback((g: PIXI.Graphics) => {
    if (!sourceNode || !targetNode) return;

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

    // Calculate midpoint for label (Bezier at t=0.5)
    const t = 0.5;
    const midX = Math.pow(1 - t, 3) * start.x + 
                 3 * Math.pow(1 - t, 2) * t * cp1.x + 
                 3 * (1 - t) * Math.pow(t, 2) * cp2.x + 
                 Math.pow(t, 3) * end.x;
    const midY = Math.pow(1 - t, 3) * start.y + 
                 3 * Math.pow(1 - t, 2) * t * cp1.y + 
                 3 * (1 - t) * Math.pow(t, 2) * cp2.y + 
                 Math.pow(t, 3) * end.y;
    
    if (Math.abs(midX - labelPos.x) > 1 || Math.abs(midY - labelPos.y) > 1) {
       setLabelPos({ x: midX, y: midY });
    }

    g.clear();
    
    // Main Line
    const lineColor = edge.selected ? 0x007bff : 0x999999;
    const lineAlpha = edge.selected ? 0.95 : 0.8;
    const lineWidth = edge.selected ? 3 : 2;
    g.lineStyle(lineWidth, lineColor, lineAlpha);
    g.moveTo(start.x, start.y);
    g.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
    
    const arrowLength = 10;
    const arrowWidth = 4;

    // End Arrow Head
    {
      const dx = end.x - cp2.x;
      const dy = end.y - cp2.y;
      const angle = Math.atan2(dy, dx);
      
      g.lineStyle(0);
      g.beginFill(lineColor);
      
      const tip = { x: end.x, y: end.y };
      const left = {
        x: end.x - arrowLength * Math.cos(angle) + arrowWidth * Math.sin(angle),
        y: end.y - arrowLength * Math.sin(angle) - arrowWidth * Math.cos(angle)
      };
      const right = {
        x: end.x - arrowLength * Math.cos(angle) - arrowWidth * Math.sin(angle),
        y: end.y - arrowLength * Math.sin(angle) + arrowWidth * Math.cos(angle)
      };
      g.drawPolygon([tip.x, tip.y, left.x, left.y, right.x, right.y]);
      g.endFill();
    }

    // Start Arrow Head (if bidirectional)
    if (edge.bidirectional) {
      const dx = start.x - cp1.x; // Vector pointing towards start
      const dy = start.y - cp1.y;
      const angle = Math.atan2(dy, dx);

      g.lineStyle(0);
      g.beginFill(lineColor);

      const tip = { x: start.x, y: start.y };
       const left = {
        x: start.x - arrowLength * Math.cos(angle) + arrowWidth * Math.sin(angle),
        y: start.y - arrowLength * Math.sin(angle) - arrowWidth * Math.cos(angle)
      };
      const right = {
        x: start.x - arrowLength * Math.cos(angle) - arrowWidth * Math.sin(angle),
        y: start.y - arrowLength * Math.sin(angle) + arrowWidth * Math.cos(angle)
      };
      g.drawPolygon([tip.x, tip.y, left.x, left.y, right.x, right.y]);
      g.endFill();
    }

    // Handoff Animation
    if (animationProgress !== null) {
      const t = animationProgress;
      const packetX = Math.pow(1 - t, 3) * start.x + 
                   3 * Math.pow(1 - t, 2) * t * cp1.x + 
                   3 * (1 - t) * Math.pow(t, 2) * cp2.x + 
                   Math.pow(t, 3) * end.x;
      const packetY = Math.pow(1 - t, 3) * start.y + 
                   3 * Math.pow(1 - t, 2) * t * cp1.y + 
                   3 * (1 - t) * Math.pow(t, 2) * cp2.y + 
                   Math.pow(t, 3) * end.y;

      // Glow (Outer)
      g.lineStyle(0);
      g.beginFill(0x4287f5, 0.4); 
      g.drawCircle(packetX, packetY, 8);
      g.endFill();

      // Core (Inner)
      g.beginFill(0xffffff, 1);
      g.drawCircle(packetX, packetY, 4);
      g.endFill();
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
  }, [sourceNode, targetNode, edge.bidirectional, edge.selected, labelPos.x, labelPos.y, animationProgress]);

  return (
    <Container>
      <Graphics draw={draw} eventMode="static" cursor="pointer" pointerdown={handlePointerDown} />
      <Text
        text={edge.label}
        x={labelPos.x}
        y={labelPos.y}
        anchor={0.5}
        style={new PIXI.TextStyle({
          fontFamily: 'Arial',
          fontSize: 10,
          fill: edge.selected ? 0x007bff : 0x666666,
          align: 'center',
          stroke: 0xffffff,
          strokeThickness: 2
        })}
        eventMode="none"
      />
    </Container>
  );
};
