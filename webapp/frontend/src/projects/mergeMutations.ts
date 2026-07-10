/**
 * MERGE Phase 2a: the mutation helpers a merger uses on the shared canvas — POST/PATCH/
 * DELETE against the candidate-object + erasure backends (webapp/projects.py), each with
 * a matching optimistic local update on the caller's `cos` / `erasures` signals so the
 * UI reacts before the round-trip completes. All mutations are best-effort: they log +
 * swallow errors here (MergeCanvasScreen doesn't need to surface them for the 2a flow),
 * but the resource caller can `refetch` to re-sync after any failure.
 *
 * Split out of MergeCanvasScreen so the screen stays ≤200 lines and each mutation stays
 * unit-testable as a pure function.
 */
import { projectsApi, type CandidateObject, type CandidateObjects, type Erasures } from './api';

export type MergeMutationOpts = {
  batchId: () => string | undefined;
  imageId: () => string | undefined;
  brushSize: () => number;
  getCos: () => CandidateObjects | undefined;
  getErasures: () => Erasures | undefined;
  setCos: (v: CandidateObjects | undefined) => void;
  setErasures: (v: Erasures | undefined) => void;
};

export interface MergeMutations {
  createGroup: (points: number[][]) => Promise<void>;
  toggleErasure: (annotationId: string) => Promise<void>;
  ungroupMark: (markId: string) => Promise<void>;
  dissolveCo: (coid: string) => Promise<void>;
}

export function createMergeMutations(o: MergeMutationOpts): MergeMutations {
  const appendCo = (co: CandidateObject) => {
    const cur = o.getCos();
    o.setCos({ candidateObjects: [...(cur?.candidateObjects ?? []), co] });
  };
  const replaceCo = (co: CandidateObject) => {
    const cur = o.getCos()?.candidateObjects ?? [];
    // Empty-member COs are soft-dissolved server-side; drop them from the list so the
    // hull layer stops rendering them (list_candidate_objects hides them going forward).
    const next = cur.map((c) => c.id === co.id ? co : c).filter((c) => c.memberIds.length > 0);
    o.setCos({ candidateObjects: next });
  };
  const dropCo = (id: string) => {
    const cur = o.getCos()?.candidateObjects ?? [];
    o.setCos({ candidateObjects: cur.filter((c) => c.id !== id) });
  };

  const createGroup = async (points: number[][]) => {
    const imageId = o.imageId(); const batchId = o.batchId();
    if (!imageId || !batchId || points.length < 2) return;
    try {
      const co = await projectsApi.createCandidateObject(batchId, {
        imageId, brushPath: points, brushWidth: o.brushSize(),
      });
      appendCo(co);
    } catch (e) { console.error('createGroup failed', e); }
  };

  const toggleErasure = async (annotationId: string) => {
    const batchId = o.batchId(); if (!batchId) return;
    const cur = o.getErasures()?.erasedIds ?? [];
    const already = cur.includes(annotationId);
    try {
      if (already) {
        await projectsApi.deleteErasure(batchId, annotationId);
        o.setErasures({ erasedIds: cur.filter((id) => id !== annotationId) });
      } else {
        await projectsApi.createErasure(batchId, annotationId);
        o.setErasures({ erasedIds: [...cur, annotationId] });
      }
    } catch (e) { console.error('toggleErasure failed', e); }
  };

  const ungroupMark = async (markId: string) => {
    const co = (o.getCos()?.candidateObjects ?? []).find((c) => c.memberIds.includes(markId));
    if (!co) return;
    try {
      const updated = await projectsApi.patchCandidateObject(co.id, { removeIds: [markId] });
      replaceCo(updated);
    } catch (e) { console.error('ungroupMark failed', e); }
  };

  const dissolveCo = async (coid: string) => {
    try {
      await projectsApi.dissolveCandidateObject(coid);
      dropCo(coid);
    } catch (e) { console.error('dissolveCo failed', e); }
  };

  return { createGroup, toggleErasure, ungroupMark, dissolveCo };
}
