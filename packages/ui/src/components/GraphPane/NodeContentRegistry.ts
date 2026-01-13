import React from 'react';
import { Node, NodeTrackedState } from '../../types';

export interface NodeContentProps {
  node: Node;
  trackedState: NodeTrackedState | undefined;
}

export type NodeContentComponent = React.ComponentType<NodeContentProps>;

const registry = new Map<string, NodeContentComponent>();

export const NodeContentRegistry = {
  register: (type: string, component: NodeContentComponent) => {
    registry.set(type, component);
  },
  get: (type: string): NodeContentComponent | undefined => {
    return registry.get(type);
  },
  unregister: (type: string) => {
    registry.delete(type);
  },
  clear: () => {
    registry.clear();
  }
};
