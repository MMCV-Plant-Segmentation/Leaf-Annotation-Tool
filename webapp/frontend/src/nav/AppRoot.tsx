import { type Component, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import type { RouteSectionProps } from '@solidjs/router';

const w = window as any;

// Captures the router's navigate fn and exposes it as window._navigate
// so vanilla JS (showHomeScreen, enterTrainingMode, etc.) can hop routes.
const AppRoot: Component<RouteSectionProps> = (props) => {
  const nav = useNavigate();
  w._navigate = (to: string) => nav(to);
  return <>{props.children}</> as JSX.Element;
};

export default AppRoot;
