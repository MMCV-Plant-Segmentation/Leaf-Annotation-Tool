import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import AppRoot from './nav/AppRoot';
import HomeScreen from './nav/HomeScreen';
import ManageScreen from './nav/ManageScreen';
import TrainScreen from './nav/TrainScreen';
import MergeScreen from './nav/MergeScreen';
import AnalyzeSetup from './analyze/AnalyzeSetup';
import AnalyzeViewerRoute from './nav/AnalyzeViewerRoute';
import LoginScreen from './nav/LoginScreen';
import AdminScreen from './nav/AdminScreen';
import InviteScreen from './nav/InviteScreen';

// ── Router: all setup screens live here ──────────────────────────────────────
const homeEl = document.getElementById('home-screen');
if (homeEl) {
  homeEl.innerHTML = '';
  render(() => (
    <Router root={AppRoot}>
      <Route path="/" component={HomeScreen} />
      <Route path="/manage" component={ManageScreen} />
      <Route path="/train" component={TrainScreen} />
      <Route path="/merge" component={MergeScreen} />
      <Route path="/analyze" component={AnalyzeSetup} />
      <Route path="/analyze/:setId" component={AnalyzeViewerRoute} />
      <Route path="/login" component={LoginScreen} />
      <Route path="/admin" component={AdminScreen} />
      <Route path="/invite/:token" component={InviteScreen} />
      <Route path="/*" component={HomeScreen} />
    </Router>
  ), homeEl);
}
