import React, { useCallback } from 'react';
import { Container, Graphics, Text } from '@pixi/react';
import { VisualNode } from '../../types/graph';
import * as PIXI from 'pixi.js';

interface GraphNodeProps {
  node: VisualNode;
  onDragStart: (id: string, event: any) => void;
  onDragEnd: () => void;
  onPortPointerDown: (id: string, portIndex: number, event: any) => void;
}

const COLOR_MAP: Record<string, number> = {
  idle: 0xcccccc,
  running: 0x66ccff,
  blocked: 0xff9900,
  failed: 0xff3333
};

// Helper to get port positions (matching GraphEdge logic)
const getPorts = (x: number, y: number, width: number, height: number) => {
  return [
    { x: x + width / 2, y: y },          // Top
    { x: x + width, y: y + height / 2 }, // Right
    { x: x + width / 2, y: y + height }, // Bottom
    { x: x, y: y + height / 2 }          // Left
  ];
};

export const GraphNode: React.FC<GraphNodeProps> = ({ node, onDragStart, onDragEnd, onPortPointerDown }) => {
  const { position, dimensions, status, label, summary, roleTemplate } = node;
  const ports = getPorts(0, 0, dimensions.width, dimensions.height);
  
  const draw = useCallback((g: PIXI.Graphics) => {
    g.clear();
    
    // Shadow
    g.beginFill(0x000000, 0.2);
    g.drawRoundedRect(4, 4, dimensions.width, dimensions.height, 12);
    g.endFill();

    // Main body
    g.lineStyle(2, node.selected ? 0x007bff : 0xdddddd);
    g.beginFill(0xffffff);
    g.drawRoundedRect(0, 0, dimensions.width, dimensions.height, 12);
    g.endFill();

    // Status Indicator
    const statusColor = COLOR_MAP[status] || 0xcccccc;
    g.lineStyle(0);
    g.beginFill(statusColor);
    g.drawCircle(20, 20, 6);
    g.endFill();

  }, [dimensions, status, node.selected]);

  return (
    <Container
      x={position.x}
      y={position.y}
      eventMode="static"
      cursor="pointer"
      pointerdown={(e) => onDragStart(node.id, e)}
      pointerup={onDragEnd}
      pointerupoutside={onDragEnd}
    >
      <Graphics draw={draw} />
      {ports.map((port, index) => (
        <Graphics
          key={`${node.id}-port-${index}`}
          draw={(g) => {
            g.clear();
            g.lineStyle(1, 0x999999, 0.5);
            g.beginFill(0xffffff);
            g.drawCircle(port.x, port.y, 4);
            g.endFill();
            g.hitArea = new PIXI.Circle(port.x, port.y, 8);
          }}
          eventMode="static"
          cursor="crosshair"
          pointerdown={(e) => {
            e.stopPropagation();
            onPortPointerDown(node.id, index, e);
          }}
        />
      ))}
      
      <Text
        text={label}
        x={35}
        y={10}
        style={new PIXI.TextStyle({
          fontFamily: 'Arial',
          fontSize: 14,
          fontWeight: 'bold',
          fill: 0x333333,
        })}
      />
      
      <Text
        text={roleTemplate}
        x={dimensions.width - 10}
        y={12}
        anchor={{ x: 1, y: 0 }}
        style={new PIXI.TextStyle({
          fontFamily: 'Arial',
          fontSize: 10,
          fill: 0x999999,
          fontStyle: 'italic'
        })}
      />

      <Text
        text={summary}
        x={20}
        y={40}
        style={new PIXI.TextStyle({
          fontFamily: 'Arial',
          fontSize: 12,
          fill: 0x666666,
          wordWrap: true,
          wordWrapWidth: dimensions.width - 40,
        })}
      />
    </Container>
  );
};
