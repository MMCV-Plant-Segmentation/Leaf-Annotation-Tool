import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import SliderField from '../src/shared/SliderField';
import ModeToggle from '../src/shared/ModeToggle';
import KBreakdown from '../src/shared/KBreakdown';
import PileDetailPanel from '../src/analyze/PileDetailPanel';
import { initStore, detailK, setDetailK } from '../src/analyze/store';
import type { AnalyzeData, Pile } from '../src/analyze/lib/types';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const MOCK_PILE: Pile = {
  id: 'P0',
  m: 3,
  bbox: [0, 0, 100, 100],
  agreementByK: {
    '1': { fraction: 1.0, rings: [[[0, 0], [100, 0], [100, 100], [0, 100]]] },
    '2': { fraction: 0.8, rings: [[[10, 10], [90, 10], [90, 90], [10, 90]]] },
    '3': { fraction: 0.6, rings: [[[20, 20], [80, 20], [80, 80], [20, 80]]] },
  },
  sourceRings: [],
};

const MOCK_DATA: AnalyzeData = {
  setId: 'test',
  displayName: 'Test',
  imageHash: 'abc',
  imageWidth: 200,
  imageHeight: 200,
  mTotal: 3,
  piles: [MOCK_PILE],
};

// ── SliderField ────────────────────────────────────────────────────────────────

describe('SliderField', () => {
  it('renders the label text', () => {
    render(() => (
      <SliderField label="Agree-K" id="s1"
        value={() => 5} onChange={() => {}} min={0} max={10}
        displayValue={() => '5'} />
    ));
    expect(screen.getByText('Agree-K')).toBeInTheDocument();
  });

  it('renders the displayValue', () => {
    render(() => (
      <SliderField label="X" id="s2"
        value={() => 7} onChange={() => {}} min={0} max={10}
        displayValue={() => '7 of 10'} />
    ));
    expect(screen.getByText('7 of 10')).toBeInTheDocument();
  });

  it('calls onChange with a parsed numeric value on change', () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <SliderField label="X" id="s3"
        value={() => 0} onChange={onChange} min={0} max={100}
        displayValue={() => '0'} />
    ));
    // Kobalte Slider renders a visually-hidden <input type="range"> that fires the change event
    fireEvent.change(container.querySelector('input[type="range"]')!, { target: { value: '42' } });
    expect(onChange).toHaveBeenCalledWith(42);
  });

  it('tooltip is hidden by default', () => {
    render(() => (
      <SliderField label="X" id="s4"
        value={() => 0} onChange={() => {}} min={0} max={10}
        displayValue={() => '0'}
        tooltip="A helpful tip" />
    ));
    expect(screen.queryByText('A helpful tip')).not.toBeInTheDocument();
  });

  it('tooltip appears after clicking the ? button', () => {
    render(() => (
      <SliderField label="X" id="s5"
        value={() => 0} onChange={() => {}} min={0} max={10}
        displayValue={() => '0'}
        tooltip="A helpful tip" />
    ));
    fireEvent.click(screen.getByText('?'));
    expect(screen.getByText('A helpful tip')).toBeInTheDocument();
  });

  it('tooltip toggles off on a second click', () => {
    render(() => (
      <SliderField label="X" id="s6"
        value={() => 0} onChange={() => {}} min={0} max={10}
        displayValue={() => '0'}
        tooltip="A helpful tip" />
    ));
    const btn = screen.getByText('?');
    fireEvent.click(btn);
    fireEvent.click(btn);
    // Kobalte Popover marks closed content with data-closed rather than unmounting it
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders no ? button when tooltip prop is omitted', () => {
    render(() => (
      <SliderField label="X" id="s7"
        value={() => 0} onChange={() => {}} min={0} max={10}
        displayValue={() => '0'} />
    ));
    expect(screen.queryByText('?')).not.toBeInTheDocument();
  });
});

// ── ModeToggle ─────────────────────────────────────────────────────────────────

describe('ModeToggle', () => {
  it('Absolute button is pressed when value is "absolute"', () => {
    render(() => <ModeToggle value={() => 'absolute'} onChange={() => {}} />);
    expect(screen.getByText('Absolute')).toHaveAttribute('data-pressed');
    expect(screen.getByText('Relative')).not.toHaveAttribute('data-pressed');
  });

  it('Relative button is pressed when value is "relative"', () => {
    render(() => <ModeToggle value={() => 'relative'} onChange={() => {}} />);
    expect(screen.getByText('Relative')).toHaveAttribute('data-pressed');
    expect(screen.getByText('Absolute')).not.toHaveAttribute('data-pressed');
  });

  it('clicking Absolute calls onChange with "absolute"', () => {
    const onChange = vi.fn();
    render(() => <ModeToggle value={() => 'relative'} onChange={onChange} />);
    fireEvent.click(screen.getByText('Absolute'));
    expect(onChange).toHaveBeenCalledWith('absolute');
  });

  it('clicking Relative calls onChange with "relative"', () => {
    const onChange = vi.fn();
    render(() => <ModeToggle value={() => 'absolute'} onChange={onChange} />);
    fireEvent.click(screen.getByText('Relative'));
    expect(onChange).toHaveBeenCalledWith('relative');
  });
});

// ── KBreakdown ─────────────────────────────────────────────────────────────────

describe('KBreakdown', () => {
  it('renders mTotal bars', () => {
    const { container } = render(() => (
      <KBreakdown mTotal={3} kAgree={() => 0} mode={() => 'absolute'}
        annotColor={() => '#4a9eff'} annotOpacity={() => 0.5} />
    ));
    expect(container.querySelectorAll('.k-bd-bar')).toHaveLength(3);
  });

  it('bar i has i+1 segments (triangle pattern)', () => {
    const { container } = render(() => (
      <KBreakdown mTotal={4} kAgree={() => 0} mode={() => 'absolute'}
        annotColor={() => '#4a9eff'} annotOpacity={() => 0.5} />
    ));
    const bars = container.querySelectorAll('.k-bd-bar');
    [1, 2, 3, 4].forEach((n, i) => {
      expect(bars[i].querySelectorAll('.k-bd-seg')).toHaveLength(n);
    });
  });

  it('segments below kAgree threshold are dim; segments at or above are active', () => {
    // mTotal=2, kAgree=2, absolute: ek=2 for all rows
    // Row 1 (mi=1): k=1 < ek → dim
    // Row 2 (mi=2): k=1 dim, k=2 active
    const { container } = render(() => (
      <KBreakdown mTotal={2} kAgree={() => 2} mode={() => 'absolute'}
        annotColor={() => '#4a9eff'} annotOpacity={() => 0.5} />
    ));
    const bars = container.querySelectorAll('.k-bd-bar');
    const row1Seg = bars[0].querySelectorAll('.k-bd-seg')[0] as HTMLElement;
    const row2Segs = bars[1].querySelectorAll('.k-bd-seg');
    const row2k1 = row2Segs[0] as HTMLElement;
    const row2k2 = row2Segs[1] as HTMLElement;

    // Both dim segments share the same inactive background
    expect(row1Seg.style.background).toBe(row2k1.style.background);
    // Active segment differs from the inactive ones
    expect(row2k2.style.background).not.toBe(row1Seg.style.background);
  });

  it('kAgree=0 makes all segments active', () => {
    // First capture what "inactive" looks like (kAgree > mTotal → all inactive)
    const { container: cAll } = render(() => (
      <KBreakdown mTotal={2} kAgree={() => 99} mode={() => 'absolute'}
        annotColor={() => '#4a9eff'} annotOpacity={() => 0.5} />
    ));
    const inactiveBg = (cAll.querySelectorAll('.k-bd-seg')[0] as HTMLElement).style.background;

    const { container } = render(() => (
      <KBreakdown mTotal={2} kAgree={() => 0} mode={() => 'absolute'}
        annotColor={() => '#4a9eff'} annotOpacity={() => 0.5} />
    ));
    for (const seg of container.querySelectorAll('.k-bd-seg')) {
      expect((seg as HTMLElement).style.background).not.toBe(inactiveBg);
    }
  });

  it('relative mode 100%: only the last segment in each bar is active', () => {
    // kAgree=100, relative: ek = max(1, ceil(1.0 * mi))
    // Row 1 (mi=1): ek=1, k=1 active
    // Row 2 (mi=2): ek=2, k=1 dim, k=2 active
    // Row 3 (mi=3): ek=3, k=1,2 dim, k=3 active
    const { container } = render(() => (
      <KBreakdown mTotal={3} kAgree={() => 100} mode={() => 'relative'}
        annotColor={() => '#4a9eff'} annotOpacity={() => 0.5} />
    ));
    const bars = container.querySelectorAll('.k-bd-bar');
    const row2Segs = bars[1].querySelectorAll('.k-bd-seg');
    const inactiveBg = (row2Segs[0] as HTMLElement).style.background; // k=1 in row2 is always dim here

    // Row 1: only segment (k=1, ek=1) is active
    expect((bars[0].querySelectorAll('.k-bd-seg')[0] as HTMLElement).style.background).not.toBe(inactiveBg);
    // Row 2: k=1 dim, k=2 active
    expect((row2Segs[1] as HTMLElement).style.background).not.toBe(inactiveBg);
    // Row 3: k=1,2 dim, k=3 active
    const row3Segs = bars[2].querySelectorAll('.k-bd-seg');
    expect((row3Segs[0] as HTMLElement).style.background).toBe(inactiveBg);
    expect((row3Segs[1] as HTMLElement).style.background).toBe(inactiveBg);
    expect((row3Segs[2] as HTMLElement).style.background).not.toBe(inactiveBg);
  });
});

// ── PileDetailPanel ────────────────────────────────────────────────────────────

describe('PileDetailPanel', () => {
  beforeEach(() => {
    // initStore resets all signals (kAgree=mTotal=3, detailK=null, mode='absolute')
    initStore(MOCK_DATA);
  });

  it('shows the annotator count in the title', () => {
    render(() => <PileDetailPanel pile={MOCK_PILE} />);
    expect(screen.getByText(/3 annotators drew this lesion/)).toBeInTheDocument();
  });

  it('renders one breakdown row per k value in the pile', () => {
    const { container } = render(() => <PileDetailPanel pile={MOCK_PILE} />);
    // pile.m = 3 → rows for k=1, k=2, k=3
    expect(container.querySelectorAll('.breakdown-row')).toHaveLength(3);
    expect(screen.getByText('≥ 1')).toBeInTheDocument();
    expect(screen.getByText('≥ 2')).toBeInTheDocument();
    expect(screen.getByText('≥ 3')).toBeInTheDocument();
  });

  it('clicking a k-row sets detailK to that k', () => {
    const { container } = render(() => <PileDetailPanel pile={MOCK_PILE} />);
    const rows = container.querySelectorAll('.breakdown-row');
    // Click the k=2 row (index 1)
    fireEvent.click(rows[1]);
    expect(detailK()).toBe(2);
  });

  it('the clicked row receives breakdown-row-active class', () => {
    const { container } = render(() => <PileDetailPanel pile={MOCK_PILE} />);
    const rows = container.querySelectorAll('.breakdown-row');
    fireEvent.click(rows[1]); // click k=2
    expect(rows[1]).toHaveClass('breakdown-row-active');
    expect(rows[0]).not.toHaveClass('breakdown-row-active');
    expect(rows[2]).not.toHaveClass('breakdown-row-active');
  });

  it('shows the IoU detail panel when agreementByK entries exist', () => {
    // initStore sets kAgree=3, detailK=null → effectiveK=3; pile has '3' and '1' entries
    render(() => <PileDetailPanel pile={MOCK_PILE} />);
    expect(screen.getByText(/Intersection/)).toBeInTheDocument();
    // polygonArea of '3' entry (60×60 square) = 3600; union '1' (100×100) = 10000 → IoU=36%
    expect(screen.getByText('36%')).toBeInTheDocument();
  });

  it('hides the IoU detail panel when the selected k has no agreementByK entry', () => {
    // Set detailK to a k that doesn't exist in the pile's agreementByK
    setDetailK(99);
    render(() => <PileDetailPanel pile={MOCK_PILE} />);
    expect(screen.queryByText(/Intersection/)).not.toBeInTheDocument();
  });
});
