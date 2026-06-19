import { Component, JSX, createSignal, onMount, onCleanup } from 'solid-js';

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
  const [tipOpen, setTipOpen] = createSignal(false);
  const minVal = () => typeof props.min === 'function' ? props.min() : props.min;
  const maxVal = () => typeof props.max === 'function' ? props.max() : props.max;

  let inputEl: HTMLInputElement | undefined;
  onMount(() => {
    if (!inputEl || !props.wheelStepping) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      props.onChange(Math.max(minVal(), Math.min(maxVal(), props.value() + dir * (props.step ?? 1))));
    };
    inputEl.addEventListener('wheel', handler, { passive: false });
    onCleanup(() => inputEl!.removeEventListener('wheel', handler));
  });

  return (
    <div class="field">
      <div style="display:flex;align-items:center;gap:4px">
        <label for={props.id}>{props.label}</label>
        {props.tooltip && (
          <button class="btn-info" onClick={() => setTipOpen(t => !t)}>?</button>
        )}
      </div>
      {props.tooltip && tipOpen() && (
        <div class="iou-tooltip">{props.tooltip}</div>
      )}
      <div class="count-header" style="margin-top:4px">
        <span style={{
          'font-size': '0.82rem',
          color: props.displayColor ?? 'var(--user)',
          'font-weight': '600',
        }}>
          {props.displayValue()}
        </span>
      </div>
      <input
        type="range"
        id={props.id}
        class="range-input"
        min={minVal()}
        max={maxVal()}
        step={props.step ?? 1}
        value={props.value()}
        ref={inputEl}
        onInput={e => props.onChange(+(e.target as HTMLInputElement).value)}
      />
      {props.children}
    </div>
  );
};

export default SliderField;
