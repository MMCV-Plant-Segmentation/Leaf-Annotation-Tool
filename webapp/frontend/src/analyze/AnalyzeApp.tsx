import { Component } from 'solid-js';
import type { AnalyzeData } from './lib/types';
import AnalyzeSetup from './AnalyzeSetup';

const AnalyzeApp: Component<{ onLaunch: (data: AnalyzeData) => void }> = (props) => {
  return <AnalyzeSetup onData={props.onLaunch} />;
};

export default AnalyzeApp;
