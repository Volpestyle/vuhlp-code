import { JsonView as JsonViewLite, allExpanded, collapseAllNested } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import './JsonView.css';

interface JsonViewProps {
  data: object | unknown[];
  shouldExpandNode?: (level: number, value: unknown, field: string | number | undefined) => boolean;
}

const defaultShouldExpand = (level: number): boolean => level < 2;

export function JsonView({ data, shouldExpandNode = defaultShouldExpand }: JsonViewProps) {
  return (
    <div className="json-view">
      <JsonViewLite
        data={data}
        shouldExpandNode={shouldExpandNode}
        style={{
          container: 'json-view__container',
          basicChildStyle: 'json-view__child',
          label: 'json-view__label',
          nullValue: 'json-view__null',
          undefinedValue: 'json-view__undefined',
          stringValue: 'json-view__string',
          booleanValue: 'json-view__boolean',
          numberValue: 'json-view__number',
          otherValue: 'json-view__other',
          punctuation: 'json-view__punctuation',
          expandIcon: 'json-view__expand-icon',
          collapseIcon: 'json-view__collapse-icon',
          collapsedContent: 'json-view__collapsed-content',
        }}
      />
    </div>
  );
}

export { allExpanded, collapseAllNested };
