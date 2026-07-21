// Shared helpers for the taxonomy v2 editor: id minting + palette colour cycling.
// Pure (no DOM/framework) so it's testable and reusable across the editor components.
import type { Compound, Group } from './taxonomy';
import { isCompoundValid } from './taxonomy';

// A small, readable default palette cycled when seeding brand-new compounds. Matches the
// BE DEFAULT_PALETTE so a fresh compound's colour is consistent end-to-end.
export const PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#0f766e',
];

/** Mint a client-side id (crypto.randomUUID with a fallback for non-secure contexts). */
export function uid(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** Next palette colour for a new compound (cycles by current count). */
export function nextColor(compounds: Compound[]): string {
  return PALETTE[compounds.length % PALETTE.length];
}

/** Deep-clone a taxonomy draft (groups + compounds) so Cancel discards cleanly. */
export function cloneDraft(groups: Group[], compounds: Compound[]): { groups: Group[]; compounds: Compound[] } {
  return {
    groups: groups.map((g) => ({ ...g, members: g.members.map((m) => ({ ...m })) })),
    compounds: compounds.map((c) => ({ ...c, selections: { ...c.selections } })),
  };
}

/** Re-stamp contiguous order across groups, members, and compounds after a reorder. */
export function restampOrder(groups: Group[], compounds: Compound[]): { groups: Group[]; compounds: Compound[] } {
  const gs = groups.map((g, i) => ({
    ...g, order: i,
    members: g.members.map((m, j) => ({ ...m, order: j })),
  }));
  return { groups: gs, compounds };
}

/**
 * t74: fold a VALID in-progress compound edit (`pending`) into the compounds list —
 * update in place if its id already exists, else append. Invalid/null pending is a no-op.
 * t89: an EMPTY name is now legal (the compound derives its label from its member
 * selections), so validity is the only gate — the name is trimmed but may be ''. Pure so
 * both the single-Save flush and the dirty check (t76) share it, and so a pending edit is
 * never silently dropped by clicking the outer Save.
 */
export function flushPending(compounds: Compound[], pending: Compound | null, groups: Group[]): Compound[] {
  if (!pending || !isCompoundValid(pending, groups)) return compounds;
  const saved = { ...pending, name: pending.name.trim() };
  return compounds.some((c) => c.id === saved.id)
    ? compounds.map((c) => (c.id === saved.id ? saved : c))
    : [...compounds, saved];
}

/**
 * t76: a stable string identity of a taxonomy draft for dirty-checking. Order-normalized
 * (contiguous group/member order) and field-order-fixed with selections sorted, so a
 * server-shaped taxonomy and a client-edited one compare equal when semantically identical.
 */
export function taxonomyKey(groups: Group[], compounds: Compound[]): string {
  const { groups: gs } = restampOrder(groups, compounds);
  const g = gs.map((x) => ({
    id: x.id, name: x.name, order: x.order, required: x.required,
    members: x.members.map((m) => ({ id: m.id, name: m.name, order: m.order })),
  }));
  const c = compounds.map((x) => ({
    id: x.id, name: x.name, color: x.color,
    selections: Object.fromEntries(Object.entries(x.selections ?? {}).sort()),
  }));
  return JSON.stringify({ g, c });
}
