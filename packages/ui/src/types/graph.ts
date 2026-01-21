import { NodeState, EdgeState } from '@vuhlp/contracts';

export interface Point {
  x: number;
  y: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface VisualNode extends NodeState {
  position: Point; // Override optional position from NodeState to be required for rendering
  dimensions: Dimensions;
  selected?: boolean;
}

export interface VisualEdge extends EdgeState {
  selected?: boolean;
}
