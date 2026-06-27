import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import { darkThemeClass, lightThemeClass, initTheme } from './theme/index';
import { initI18n } from './i18n/index';
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
import ProjectsScreen from './projects/ProjectsScreen';
import ProjectDetailScreen from './projects/ProjectDetailScreen';
import CanvasScreen from './projects/CanvasScreen';

// Apply theme class to body on boot (dark default, respects localStorage).
initTheme(darkThemeClass, lightThemeClass);

// Load i18n catalog (resolves locale, fetches /api/i18n/<locale>, exposes window.t)
// before the Solid render so every t() call has data from the first paint.
void initI18n().then(() => {
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
        <Route path="/projects" component={ProjectsScreen} />
        <Route path="/projects/:id" component={ProjectDetailScreen} />
        <Route path="/projects/:id/batches/:batchId" component={CanvasScreen} />
        <Route path="/*" component={HomeScreen} />
      </Router>
    ), homeEl);
  }
});
