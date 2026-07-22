/**
 * Colour-coded label picker for the canvas paint/relabel drop-down. A native <select>
 * can't reliably colour each <option> row (browser/OS-drawn chrome ignores per-row
 * styling), so this is a small custom dropdown built on Kobalte's Select primitive —
 * keyboard nav (arrows, type-ahead, Enter, Escape), ARIA semantics (combobox/listbox/
 * option) and focus management come from Kobalte, matching the accessibility of the
 * native control it replaces.
 *
 * Preserves the out-of-set free-text fallback (the backend is lenient — an
 * unconfigured label stays selectable/paintable) by folding the current value into the
 * option list as a synthetic, neutrally-coloured entry when it isn't one of `options`.
 */
import { type Component } from 'solid-js';
import { Select } from '@kobalte/core/select';
import type { Label } from './api';
import { vars } from '../theme/contract.css';
import * as styles from './LabelPicker.css';

type Props = {
  value: () => string;
  onChange: (name: string) => void;
  options: () => Label[];
  ariaLabel: string;
  testId: string;
};

// t109: a broken (folded-in INVALID compound) option is flagged with a leading "⚠" —
// display only, the underlying `name` (the resolvable paint value) is untouched.
const labelText = (item: Label | null): string =>
  item ? (item.broken ? `⚠ ${item.name}` : item.name) : '';

export const LabelPicker: Component<Props> = (props) => {
  const items = (): Label[] => {
    const opts = props.options();
    const v = props.value();
    if (v && !opts.some((o) => o.name === v)) {
      return [...opts, { id: `__free:${v}`, name: v, color: vars.color.textMuted, order: opts.length }];
    }
    return opts;
  };
  // Falls back to the first item so the trigger always shows SOMETHING sane, mirroring
  // a native <select>'s implicit-first-option display when the value doesn't (yet) match.
  const selected = (): Label | null => {
    const list = items();
    return list.find((o) => o.name === props.value()) ?? list[0] ?? null;
  };

  return (
    <Select
      options={items()}
      optionValue="name"
      optionTextValue="name"
      value={selected()}
      onChange={(opt) => opt && props.onChange(opt.name)}
      disallowEmptySelection
      itemComponent={(ip) => (
        <Select.Item item={ip.item} class={styles.item}
          style={{ color: ip.item.rawValue.color }}>
          <Select.ItemLabel>{labelText(ip.item.rawValue)}</Select.ItemLabel>
        </Select.Item>
      )}
    >
      <Select.Trigger class={styles.trigger} data-testid={props.testId} aria-label={props.ariaLabel}>
        {/* Static children (not Select.Value's render-prop form) — driven by OUR OWN
            `selected()` accessor so this never needs Kobalte's internal generic state. */}
        <Select.Value class={styles.value}>
          <span style={{ color: selected()?.color }}>{labelText(selected())}</span>
        </Select.Value>
        <Select.Icon class={styles.icon}>▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content class={styles.content}>
          <Select.Listbox class={styles.listbox} data-testid={`${props.testId}-listbox`} />
        </Select.Content>
      </Select.Portal>
    </Select>
  );
};

export default LabelPicker;
