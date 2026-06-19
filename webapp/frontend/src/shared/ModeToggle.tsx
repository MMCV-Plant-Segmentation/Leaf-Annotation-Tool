import { Component } from 'solid-js';
import type { Mode } from '../analyze/lib/types';

interface Props {
  value: () => Mode;
  onChange: (m: Mode) => void;
}

const ModeToggle: Component<Props> = (props) => (
  <div class="mode-toggle-group">
    <button
      class={`mode-toggle-btn${props.value() === 'absolute' ? ' active' : ''}`}
      onClick={() => props.onChange('absolute')}
    >Absolute</button>
    <button
      class={`mode-toggle-btn${props.value() === 'relative' ? ' active' : ''}`}
      onClick={() => props.onChange('relative')}
    >Relative</button>
  </div>
);

export default ModeToggle;
