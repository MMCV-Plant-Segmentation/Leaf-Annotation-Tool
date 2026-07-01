/**
 * Pure helpers for the admin sync-status card (SyncStatusCard.tsx). Kept framework-free
 * so the freshness thresholds and "time ago" text are directly unit-testable.
 *
 * Thresholds (docs/plans/Plan — Admin sync-status panel.md, DECISION 2026-07-01):
 *   green  < 15 min
 *   amber  < 2 h
 *   red    older, unreachable (ageSec == null), or not configured
 */
import { t } from '../i18n/catalog';

export type Freshness = 'green' | 'amber' | 'red';

const GREEN_MAX_SEC = 15 * 60;
const AMBER_MAX_SEC = 2 * 60 * 60;

export function classifyAge(ageSec: number | null): Freshness {
  if (ageSec === null) return 'red';
  if (ageSec < GREEN_MAX_SEC) return 'green';
  if (ageSec < AMBER_MAX_SEC) return 'amber';
  return 'red';
}

/** Human-readable "X ago" string, or the "unknown" catalog string when ageSec is null. */
export function formatAgo(ageSec: number | null): string {
  if (ageSec === null) return t('admin.syncStatus.unknown');
  const mins = Math.floor(ageSec / 60);
  if (mins < 1) return t('admin.syncStatus.agoSeconds', { n: Math.floor(ageSec) });
  if (mins < 60) return t('admin.syncStatus.agoMinutes', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('admin.syncStatus.agoHours', { n: hours });
  return t('admin.syncStatus.agoDays', { n: Math.floor(hours / 24) });
}
