import { Component } from 'solid-js';
import { Root as ToggleGroupRoot, Item as ToggleGroupItem } from '@kobalte/core/toggle-group';
import type { Mode } from '../analyze/lib/types';
import styles from './ModeToggle.module.css';

interface Props {
  value: () => Mode;
  onChange: (m: Mode) => void;
}

const ModeToggle: Component<Props> = (props) => (
  <ToggleGroupRoot
    class={styles.modeToggleGroup}
    value={props.value()}
    onChange={(v: string | null) => { if (v) props.onChange(v as Mode); }}
    multiple={false}
  >
    <ToggleGroupItem class={styles.modeToggleBtn} value="absolute">Absolute</ToggleGroupItem>
    <ToggleGroupItem class={styles.modeToggleBtn} value="relative">Relative</ToggleGroupItem>
  </ToggleGroupRoot>
);

export default ModeToggle;
