import { type Component, createSignal, Show, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Root as CheckboxRoot, Control as CheckboxControl, Indicator as CheckboxIndicator }
  from '@kobalte/core/checkbox';
import { Root as SliderRoot, Track as SliderTrack, Fill as SliderFill,
         Thumb as SliderThumb, Input as SliderInput } from '@kobalte/core/slider';
import type { PairSummary } from '../analyze/lib/types';
import { type TrainSession, calcForkInfo } from './trainHelpers';
import PairList from '../shared/PairList';
import styles from './TrainScreen.module.css';
import pairStyles from '../shared/PairList.module.css';
import ui from '../shared/ui.module.css';
import { setKindClass } from '../shared/uiHelpers';

const w = window as any;

const TrainScreen: Component = () => {
  const navigate = useNavigate();
  const [pairs,         setPairs]         = createSignal<PairSummary[]>([]);
  const [loading,       setLoading]       = createSignal(true);
  const [view,          setView]          = createSignal<'fork' | 'config'>('config');
  const [savedSession,  setSavedSession]  = createSignal<TrainSession | null>(null);
  const [deletedNotice, setDeletedNotice] = createSignal(false);

  // Config-view state
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [polygon,    setPolygon]    = createSignal(false);
  const [label,      setLabel]      = createSignal(false);
  const [n,          setN]          = createSignal(1);
  const [nMax,       setNMax]       = createSignal(1);
  const [modeError,  setModeError]  = createSignal(false);
  const [launching,  setLaunching]  = createSignal(false);

  onMount(async () => {
    const data: PairSummary[] = await fetch('/api/images').then(r => r.json());
    const trainable = data.filter(p => p.kind === 'raw' || p.kind === 'reannotated');
    setPairs(trainable);
    setLoading(false);

    const saved: TrainSession | null = w._readSession?.() ?? null;
    if (saved && trainable.some(p => p.id === saved.pairId)) {
      setSavedSession(saved);
      setView('fork');
    } else {
      if (saved) { setDeletedNotice(true); w._clearSession?.(); }
      if (trainable.length > 0) {
        setSelectedId(trainable[0].id);
        setNMax(trainable[0].shape_count);
        setN(trainable[0].shape_count);
      }
      setView('config');
    }
  });

  function selectPair(p: PairSummary) {
    setSelectedId(p.id);
    setNMax(p.shape_count);
    setN(p.shape_count);
  }

  async function resume() {
    const saved = savedSession();
    if (!saved || launching()) return;
    setLaunching(true);
    await w._resumeTrainer?.(saved);
  }

  async function startNew() {
    if (!polygon() && !label()) { setModeError(true); return; }
    if (!selectedId() || launching()) return;
    setModeError(false);
    setLaunching(true);
    const mode = polygon() && label() ? 'both' : polygon() ? 'polygon' : 'label';
    await w._launchTrainer?.(selectedId(), mode, n());
  }

  return (
    <>
      {/* ── Fork view: resume or start fresh ── */}
      <Show when={view() === 'fork'}>
        <div class={pairStyles.resumeInfo} innerHTML={calcForkInfo(savedSession(), pairs())} />
        <button class={ui.btnPrimary} style="margin-top:10px"
                disabled={launching()} onClick={resume}>
          {launching() ? 'Starting…' : 'Continue session'}
        </button>
        <button class={ui.btnSecondary} style="width:100%;margin-top:8px"
                onClick={() => { setSavedSession(null); setView('config'); }}>
          New session →
        </button>
        <button class={ui.btnText} style="margin-top:8px" onClick={() => navigate('/')}>← Home</button>
      </Show>

      {/* ── Config view: pair + mode + card count ── */}
      <Show when={view() === 'config'}>
        <Show when={deletedNotice()}>
          <div class={styles.noticeBanner}>
            <span>Your previous session's annotation set was deleted.</span>
            <button class={styles.noticeDismiss} onClick={() => setDeletedNotice(false)}>✕</button>
          </div>
        </Show>

        <p class={pairStyles.setupSub}>Annotation set</p>

        <Show when={!loading()} fallback={<p class={pairStyles.setupSub}>Loading…</p>}>
          <Show when={pairs().length === 0}>
            <p class={pairStyles.pairEmpty}>No annotation sets yet.</p>
          </Show>
          <PairList
            pairs={pairs()}
            selectedId={selectedId()}
            onSelect={selectPair}
            renderDetail={(p) => (
              <>
                <div class={pairStyles.pairTagsRow}>
                  <span class={`${ui.setKindTag} ${setKindClass(ui, p.kind)}`}>{p.kind}</span>
                </div>
                <span style="font-size:0.75rem;color:var(--muted)">{p.shape_count} shapes</span>
              </>
            )}
          />
        </Show>

        <p class={pairStyles.setupSub} style="margin-top:14px">What would you like to practice?</p>

        <div class={styles.modeChecks}>
          <CheckboxRoot
            class={`${styles.modeCheck}${polygon() ? ' ' + styles.selected : ''}`}
            checked={polygon()}
            onChange={(v: boolean) => { setPolygon(v); setModeError(false); }}
          >
            <CheckboxControl style="display:none"><CheckboxIndicator /></CheckboxControl>
            <div class={styles.modeCheckText}>
              <strong>Polygon drawing</strong>
              <span>Trace the lesion boundary</span>
            </div>
          </CheckboxRoot>
          <CheckboxRoot
            class={`${styles.modeCheck}${label() ? ' ' + styles.selected : ''}`}
            checked={label()}
            onChange={(v: boolean) => { setLabel(v); setModeError(false); }}
          >
            <CheckboxControl style="display:none"><CheckboxIndicator /></CheckboxControl>
            <div class={styles.modeCheckText}>
              <strong>Label identification</strong>
              <span>Name the lesion type</span>
            </div>
          </CheckboxRoot>
        </div>

        <div class={styles.countField}>
          <div class={ui.countHeader}>
            <label>Cards per session</label>
            <span>{n() === nMax() ? `All (${n()})` : String(n())}</span>
          </div>
          <SliderRoot
            class={styles.slider}
            value={[n()]}
            minValue={1}
            maxValue={nMax()}
            onChange={([v]) => setN(v)}
          >
            <SliderTrack class={styles.sliderTrack}>
              <SliderFill class={styles.sliderFill} />
              <SliderThumb class={styles.sliderThumb}>
                <SliderInput />
              </SliderThumb>
            </SliderTrack>
          </SliderRoot>
        </div>

        <Show when={modeError()}>
          <p class={styles.errorText}>Please select at least one mode.</p>
        </Show>

        <button
          class={ui.btnPrimary}
          disabled={!selectedId() || launching()}
          onClick={startNew}
        >
          {launching() ? 'Starting…' : 'Start Training'}
        </button>

        <Show when={savedSession()}>
          <button class={ui.btnText} style="margin-top:6px"
                  onClick={() => setView('fork')}>← Back</button>
        </Show>
        <button class={ui.btnText} style="margin-top:6px" onClick={() => navigate('/')}>← Home</button>
      </Show>
    </>
  );
};

export default TrainScreen;
