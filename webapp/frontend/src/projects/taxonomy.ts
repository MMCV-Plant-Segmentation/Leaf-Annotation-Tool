// Taxonomy v2 types — groups + saved compound labels (per-project, no sharing).
// Mirrors webapp/taxonomy.py's read surface. Kept in its own module so api.ts stays
// under 200 lines; re-exported from api.ts.

/** A group member: a name + order ONLY (members carry NO colour). */
export type Member = { id: string; name: string; order: number };

/** A group: ordered members + a required? flag. Members are mutually exclusive. */
export type Group = {
  id: string;
  name: string;
  order: number;
  required: boolean;
  members: Member[];
};

/**
 * A saved COMPOUND label = { name, color, selections } where selections maps each chosen
 * group id -> one of its member ids. Valid only if it selects a member for every REQUIRED
 * group (optional groups may be omitted). Compounds are the paintable, coloured palette.
 */
export type Compound = {
  id: string;
  name: string;
  color: string;
  selections: Record<string, string>;
};

/** The full taxonomy read surface (groups + the valid compound palette + flat classes). */
export type Taxonomy = {
  groups: Group[];
  compounds: Compound[];
  /** Compounds projected to the legacy flat {id,name,color,order} (single-group parity). */
  classes: { id: string; name: string; color: string; order: number }[];
};

/** A group id -> {memberId, memberName, groupName} entry in a lesion's snapshot. */
export type SnapshotSelection = {
  memberId: string;
  memberName: string;
  groupName: string;
};

/** The denormalised compound snapshot stored on a lesion at assign time. */
export type LabelSnapshot = {
  name: string;
  color: string;
  selections: Record<string, SnapshotSelection>;
};

/**
 * Is a compound valid against the current groups? Mirrors webapp.taxonomy.is_compound_valid:
 * selects an existing member for every required group; every selection present points at a
 * real group+member. Pure (used by the editor to block saving invalid compounds).
 */
export function isCompoundValid(compound: Compound, groups: Group[]): boolean {
  const sel = compound.selections || {};
  for (const g of groups) {
    if (!g.required) continue;
    const mid = sel[g.id];
    if (!mid) return false;
    if (!g.members.some((m) => m.id === mid)) return false;
  }
  const memberIdsByGroup = new Map(groups.map((g) => [g.id, new Set(g.members.map((m) => m.id))]));
  for (const [gid, mid] of Object.entries(sel)) {
    const set = memberIdsByGroup.get(gid);
    if (!set || !set.has(mid)) return false;
  }
  return true;
}
