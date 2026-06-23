import { Component } from 'solid-js';
import { Root as ToggleGroupRoot, Item as ToggleGroupItem } from '@kobalte/core/toggle-group';
import type { Mode } from '../analyze/lib/types';

interface Props {
  value: () => Mode;
  onChange: (m: Mode) => void;
}

const ModeToggle: Component<Props> = (props) => (
  <ToggleGroupRoot
    class="mode-toggle-group"
    value={props.value()}
    onChange={(v: string | null) => { if (v) props.onChange(v as Mode); }}
    multiple={false}
  >
    <ToggleGroupItem class="mode-toggle-btn" value="absolute">Absolute</ToggleGroupItem>
    <ToggleGroupItem class="mode-toggle-btn" value="relative">Relative</ToggleGroupItem>
  </ToggleGroupRoot>
);

export default ModeToggle;
