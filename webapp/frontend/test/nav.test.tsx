import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { Router, Route } from '@solidjs/router';
import type { Component } from 'solid-js';
import ManageScreen from '../src/nav/ManageScreen';
import TrainScreen from '../src/nav/TrainScreen';
import MergeScreen from '../src/nav/MergeScreen';
import AnalyzeSetup from '../src/analyze/AnalyzeSetup';
import type { PairSummary } from '../src/analyze/lib/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePair(overrides: Partial<PairSummary> = {}): PairSummary {
  return {
    id: 'p1', display_name: 'Test Set', kind: 'raw',
    image_hash: 'abc', image_ext: 'tif',
    shape_count: 10, pile_count: null,
    terminal: false, created_by: 'x', created_at: '', uploaded_at: '',
    ...overrides,
  };
}

function mockFetch(json: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve(json) }));
}

// useNavigate requires being inside a <Route>, not just a <Router>
function inRoute(C: Component) {
  return () => <Router><Route path="/*" component={C} /></Router>;
}

// ── ManageScreen ───────────────────────────────────────────────────────────────

describe('ManageScreen', () => {
  beforeEach(() => mockFetch([]));
  afterEach(() => vi.unstubAllGlobals());

  it('renders "Annotation sets" heading', async () => {
    render(inRoute(ManageScreen));
    await screen.findByText('Annotation sets');
  });

  it('shows empty state when no pairs returned', async () => {
    render(inRoute(ManageScreen));
    await screen.findByText(/No annotation sets yet/);
  });

  it('shows "+ Add new annotation set" button after load', async () => {
    render(inRoute(ManageScreen));
    await screen.findByText('+ Add new annotation set');
  });

  it('renders a pair row when pairs are returned', async () => {
    mockFetch([makePair({ display_name: 'My Slides' })]);
    render(inRoute(ManageScreen));
    await screen.findByText('My Slides');
  });

  it('shows rename and delete action buttons per pair', async () => {
    mockFetch([makePair()]);
    render(inRoute(ManageScreen));
    await screen.findByTitle('Rename');
    expect(screen.getByTitle('Delete')).toBeInTheDocument();
  });

  it('shows add form on "+ Add" click', async () => {
    render(inRoute(ManageScreen));
    const btn = await screen.findByText('+ Add new annotation set');
    btn.click();
    expect(screen.getByPlaceholderText('Display name')).toBeInTheDocument();
  });
});

// ── TrainScreen ───────────────────────────────────────────────────────────────

describe('TrainScreen', () => {
  beforeEach(() => {
    mockFetch([]);
    (window as any)._readSession = () => null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows "Annotation set" and mode checkboxes in config view', async () => {
    render(inRoute(TrainScreen));
    await screen.findByText('Annotation set');
    expect(screen.getByText('What would you like to practice?')).toBeInTheDocument();
    expect(screen.getByText('Polygon drawing')).toBeInTheDocument();
    expect(screen.getByText('Label identification')).toBeInTheDocument();
  });

  it('shows empty state when no trainable pairs', async () => {
    render(inRoute(TrainScreen));
    await screen.findByText(/No annotation sets yet/);
  });

  it('lists a trainable pair', async () => {
    mockFetch([makePair({ display_name: 'Lesion Batch A' })]);
    render(inRoute(TrainScreen));
    await screen.findByText('Lesion Batch A');
  });

  it('merged sets are excluded from the pair list', async () => {
    mockFetch([
      makePair({ id: 'raw1', display_name: 'Raw Set', kind: 'raw' }),
      makePair({ id: 'm1',   display_name: 'Merged Set', kind: 'merged' }),
    ]);
    render(inRoute(TrainScreen));
    await screen.findByText('Raw Set');
    expect(screen.queryByText('Merged Set')).not.toBeInTheDocument();
  });

  it('shows fork view (Continue session) when a valid saved session exists', async () => {
    mockFetch([makePair({ id: 'p1', display_name: 'My Set' })]);
    (window as any)._readSession = () => ({
      pairId: 'p1', mode: 'both',
      shapePool: [0, 1, 2], polygonScores: {}, labelScores: {},
      attempts: { 0: 1 }, suspended: [],
    });
    render(inRoute(TrainScreen));
    await screen.findByText('Continue session');
    await screen.findByText('New session →');
  });

  it('shows config view (not fork) when saved session pair no longer exists', async () => {
    mockFetch([makePair({ id: 'other' })]);
    (window as any)._readSession = () => ({
      pairId: 'deleted', mode: 'both',
      shapePool: [0], polygonScores: {}, labelScores: {},
      attempts: {}, suspended: [],
    });
    (window as any)._clearSession = vi.fn();
    render(inRoute(TrainScreen));
    await screen.findByText('Annotation set');
    expect(screen.queryByText('Continue session')).not.toBeInTheDocument();
  });
});

// ── AnalyzeSetup ─────────────────────────────────────────────────────────────

describe('AnalyzeSetup', () => {
  beforeEach(() => mockFetch([]));
  afterEach(() => vi.unstubAllGlobals());

  it('shows "Loading…" while fetching', () => {
    render(inRoute(AnalyzeSetup));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows eligible pairs after fetch', async () => {
    mockFetch([
      makePair({ id: 'm1', display_name: 'Merged Set', kind: 'merged', pile_count: 5 }),
      makePair({ id: 'r1', display_name: 'Raw Set', kind: 'raw' }),
    ]);
    render(inRoute(AnalyzeSetup));
    await screen.findByText('Merged Set');
    expect(screen.queryByText('Raw Set')).not.toBeInTheDocument();
  });

  it('shows empty state when no eligible sets', async () => {
    mockFetch([makePair({ kind: 'raw' })]);
    render(inRoute(AnalyzeSetup));
    await screen.findByText(/No merged or reannotated sets/);
  });

  it('does not read window.availablePairs — fetches independently', async () => {
    (window as any).availablePairs = [];
    mockFetch([makePair({ id: 'm1', display_name: 'Should Appear', kind: 'merged' })]);
    render(inRoute(AnalyzeSetup));
    await screen.findByText('Should Appear');
  });
});

// ── MergeScreen ───────────────────────────────────────────────────────────────

describe('MergeScreen', () => {
  beforeEach(() => {
    mockFetch([]);
    (window as any)._readCompareSession = async () => null;
    (window as any).availablePairs = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows "Image" heading in setup view', async () => {
    render(inRoute(MergeScreen));
    await screen.findByText('Image');
  });

  it('shows empty state when no pairs', async () => {
    render(inRoute(MergeScreen));
    await screen.findByText(/No annotation sets yet/);
  });

  it('groups pairs by image_hash into one image row', async () => {
    const pairs = [
      makePair({ id: 'a', display_name: 'Slide 1', image_hash: 'h1' }),
      makePair({ id: 'b', display_name: 'Slide 1 v2', image_hash: 'h1', kind: 'reannotated' }),
    ];
    mockFetch(pairs);
    (window as any).availablePairs = pairs;
    render(inRoute(MergeScreen));
    // One image row for hash 'h1', showing set count
    await screen.findByText('2 annotation sets');
  });

  it('shows fork view when a saved comparison exists', async () => {
    const pairs = [makePair({ image_hash: 'h1', display_name: 'Slide A' })];
    mockFetch(pairs);
    (window as any).availablePairs = pairs;
    (window as any)._readCompareSession = async () => ({
      imageHash: 'h1', includedSetIds: ['p1'], piles: { P1: {}, P2: {} },
    });
    render(inRoute(MergeScreen));
    await screen.findByText('Continue comparison');
    expect(screen.getByText('New comparison →')).toBeInTheDocument();
    expect(screen.getByText('✕ Delete saved comparison')).toBeInTheDocument();
  });

  it('shows set checkboxes after selecting an image', async () => {
    const pairs = [
      makePair({ id: 'a', display_name: 'Set A', image_hash: 'h1' }),
      makePair({ id: 'b', display_name: 'Set B', image_hash: 'h1', kind: 'reannotated' }),
    ];
    mockFetch(pairs);
    (window as any).availablePairs = pairs;
    render(inRoute(MergeScreen));
    const imageRow = await screen.findByText('2 annotation sets');
    // Without a prior pointerdown, Kobalte Listbox onClick fires onSelect unconditionally
    fireEvent.click(imageRow);
    await screen.findByText('Annotation sets');
    // checkbox labels include the shape count; image row only shows set count
    expect(screen.getByText(/Set A \(10 shapes\)/)).toBeInTheDocument();
    expect(screen.getByText(/Set B \(10 shapes\)/)).toBeInTheDocument();
  });
});
