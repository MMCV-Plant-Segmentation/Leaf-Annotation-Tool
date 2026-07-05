// Shared helpers for the taxonomy v2 editor: id minting + palette colour cycling.
// Pure (no DOM/framework) so it's testable and reusable across the editor components.
import type { Compound, Group } from './taxonomy';

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
