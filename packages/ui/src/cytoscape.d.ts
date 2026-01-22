// Cytoscape provides its own types but they're bundled differently
// This declaration ensures TypeScript can find them
declare module 'cytoscape' {
  export interface Position {
    x: number;
    y: number;
  }

  export interface ZoomOptions {
    level: number;
    renderedPosition?: Position;
  }

  export interface AnimateOptions {
    fit?: {
      eles: unknown;
      padding?: number;
    };
    zoom?: number | ZoomOptions;
    duration?: number;
    easing?: string;
    complete?: () => void;
  }

  export interface ElementDataDefinition {
    id?: string;
    source?: string;
    target?: string;
    [key: string]: unknown;
  }

  export interface ElementDefinition {
    data: ElementDataDefinition;
    position?: Position;
    group?: 'nodes' | 'edges';
    classes?: string | string[];
    selected?: boolean;
    selectable?: boolean;
    grabbable?: boolean;
    locked?: boolean;
  }

  export interface Stylesheet {
    selector: string;
    style: Record<string, string | number>;
  }

  export interface LayoutOptions {
    name: string;
    directed?: boolean;
    padding?: number;
    spacingFactor?: number;
    [key: string]: unknown;
  }

  export interface CytoscapeOptions {
    container?: HTMLElement | null;
    elements?: ElementDefinition[];
    style?: Stylesheet[];
    layout?: LayoutOptions;
    minZoom?: number;
    maxZoom?: number;
    wheelSensitivity?: number;
    [key: string]: unknown;
  }

  export interface EventObject {
    target: Core | NodeSingular | EdgeSingular;
    type: string;
    originalEvent?: Event;
  }

  export interface NodeSingular {
    id(): string;
    data(): ElementDataDefinition;
    data(name: string): unknown;
    data(name: string, value: unknown): void;
    data(data: ElementDataDefinition): void;
    style(name: string, value?: string | number): NodeSingular;
    position(): Position;
    position(pos: Position): void;
    neighborhood(selector?: string): CollectionReturn;
    connectedEdges(selector?: string): EdgeCollection;
    addClass(classes: string): NodeSingular;
    removeClass(classes: string): NodeSingular;
    nonempty(): boolean;
  }

  export interface EdgeSingular {
    id(): string;
    data(): ElementDataDefinition;
    data(name: string): unknown;
    data(name: string, value: unknown): void;
    data(data: ElementDataDefinition): void;
    style(name: string, value?: string | number): EdgeSingular;
    source(): NodeSingular;
    target(): NodeSingular;
    addClass(classes: string): EdgeSingular;
    removeClass(classes: string): EdgeSingular;
  }

  export interface CollectionReturn {
    remove(): void;
    addClass(classes: string): CollectionReturn;
    removeClass(classes: string): CollectionReturn;
    filter(selector: string | ((ele: any) => boolean)): CollectionReturn;
    length: number;
  }

  export interface NodeCollection {
    forEach(callback: (node: NodeSingular, index: number, collection: NodeCollection) => void): void;
    map<T>(callback: (node: NodeSingular, index: number, collection: NodeCollection) => T): T[];
    filter(callback: (node: NodeSingular, index: number, collection: NodeCollection) => boolean): NodeCollection;
    some(callback: (node: NodeSingular, index: number, collection: NodeCollection) => boolean): boolean;
    position(): Position;
    length: number;
    connectedEdges(): EdgeCollection;
    contains(ele: any): boolean;
    removeClass(classes: string): NodeCollection;
  }

  export interface EdgeCollection {
     forEach(callback: (edge: EdgeSingular, index: number, collection: EdgeCollection) => void): void;
     map<T>(callback: (edge: EdgeSingular, index: number, collection: EdgeCollection) => T): T[];
     filter(callback: (edge: EdgeSingular, index: number, collection: EdgeCollection) => boolean): EdgeCollection;
     removeClass(classes: string): EdgeCollection;
     addClass(classes: string): EdgeCollection;
     length: number;
  }

  export interface LayoutManipulation {
    run(): void;
  }

  export interface StyleManipulator {
    selector(selector: string): StyleManipulator;
    style(style: Record<string, string | number>): StyleManipulator;
    update(): void;
  }

  export interface Core {
    add(elements: ElementDefinition | ElementDefinition[]): void;
    remove(elements?: string): void;
    elements(): CollectionReturn;
    nodes(): NodeCollection;
    edges(): EdgeCollection;
    getElementById(id: string): NodeSingular | EdgeSingular;
    on(event: string, handler: (evt: EventObject) => void): void;
    on(event: string, selector: string, handler: (evt: EventObject) => void): void;
    style(): StyleManipulator;
    zoom(level?: number): number;
    zoom(options: ZoomOptions): void;
    fit(elements?: unknown, padding?: number): void;
    layout(options: LayoutOptions): LayoutManipulation;
    destroy(): void;
    batch(callback: () => void): void;
    pan(): Position;
    animate(options: AnimateOptions): void;
    stop(): void;
    resize(): void;
  }

  export default function cytoscape(options?: CytoscapeOptions): Core;
}
