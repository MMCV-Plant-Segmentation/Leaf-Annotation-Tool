import { Component, JSX, Show, onMount, onCleanup } from 'solid-js';
import { Root as SliderRoot, Track as SliderTrack, Fill as SliderFill,
         Thumb as SliderThumb, Input as SliderInput } from '@kobalte/core/slider';
import { Root as PopoverRoot, Trigger as PopoverTrigger,
         Portal as PopoverPortal, Content as PopoverContent } from '@kobalte/core/popover';
import * as styles from './SliderField.css';
import * as ui from './ui.css';

interface Props {
  label: string;
  id: string;
  tooltip?: string;
  value: () => number;
  onChange: (v: number) => void;
  min: number | (() => number);
  max: number | (() => number);
  step?: number;
  displayValue: () => string;
  displayColor?: string;
  wheelStepping?: boolean;
  children?: JSX.Element;
}

const SliderField: Component<Props> = (props) => {
  const minVal = () => typeof props.min === 'function' ? props.min() : props.min;
  const maxVal = () => typeof props.max === 'function' ? props.max() : props.max;

  let trackRef: HTMLElement | undefined;
  onMount(() => {
    if (!trackRef || !props.wheelStepping) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      props.onChange(Math.max(minVal(), Math.min(maxVal(), props.value() + dir * (props.step ?? 1))));
    };
    trackRef.addEventListener('wheel', handler, { passive: false });
    onCleanup(() => trackRef!.removeEventListener('wheel', handler));
  });

  return (
    <div class={ui.field}>
      <div style="display:flex;align-items:center;gap:4px">
        <label>{props.label}</label>
        <Show when={props.tooltip}>
          {(tip) => (
            <PopoverRoot>
              <PopoverTrigger class={ui.btnInfo}>?</PopoverTrigger>
              <PopoverPortal>
                <PopoverContent class={ui.iouTooltip}>{tip()}</PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
          )}
        </Show>
      </div>
      <div class={ui.countHeader} style="margin-top:4px">
        <span style={{
          'font-size': '0.82rem',
          color: props.displayColor ?? 'var(--user)',
          'font-weight': '600',
        }}>
          {props.displayValue()}
        </span>
      </div>
      <SliderRoot
        class={styles.slider}
        ref={(el: HTMLElement) => { trackRef = el; }}
        value={[props.value()]}
        minValue={minVal()}
        maxValue={maxVal()}
        step={props.step ?? 1}
        onChange={([v]) => props.onChange(v)}
      >
        <SliderTrack class={styles.track}>
          <SliderFill class={styles.fill} />
          <SliderThumb class={styles.thumb}>
            <SliderInput id={props.id} />
          </SliderThumb>
        </SliderTrack>
      </SliderRoot>
      {props.children}
    </div>
  );
};

export default SliderField;
