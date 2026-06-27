import { type Component, type JSX } from 'solid-js';
import { Root as ListboxRoot, Item as ListboxItem } from '@kobalte/core/listbox';
import type { PairSummary } from '../analyze/lib/types';
import * as pairStyles from './PairList.css';

export interface PairListProps {
  pairs: PairSummary[];
  selectedId: string | null;
  onSelect: (p: PairSummary) => void;
  renderDetail?: (p: PairSummary) => JSX.Element;
}

const PairList: Component<PairListProps> = (props) => (
  <ListboxRoot
    as="div"
    options={props.pairs}
    optionValue="id"
    optionTextValue="display_name"
    value={props.selectedId ? [props.selectedId] : []}
    onChange={(set: Set<string>) => {
      const id = [...set][0];
      if (id) {
        const p = props.pairs.find(q => q.id === id);
        if (p) props.onSelect(p);
      }
    }}
    renderItem={(node: any) => (
      <ListboxItem item={node} as="div" class={pairStyles.pairItem} data-id={node.rawValue.id}>
        <div class={pairStyles.pairItemLeft}>
          <strong>{node.rawValue.display_name}</strong>
          {props.renderDetail?.(node.rawValue)}
        </div>
      </ListboxItem>
    )}
  />
);

export default PairList;
