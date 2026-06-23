import { type Component } from 'solid-js';
import AnalyzeApp from '../analyze/AnalyzeApp';
import type { AnalyzeData } from '../analyze/lib/types';

const w = window as any;

// Route wrapper: renders AnalyzeApp directly (no #analyze-setup HTML needed).
// The actual viewer launch is delegated to window._launchAnalyze (set by initAnalyze).
const AnalyzeRoute: Component = () => (
  <AnalyzeApp onLaunch={(data: AnalyzeData) => w._launchAnalyze?.(data)} />
);

export default AnalyzeRoute;
