export type Mode = 'absolute' | 'relative';

export type Ring = [number, number][];

export interface AgreementLevel {
  fraction: number;
  rings: Ring[];
}

export interface SourceRings {
  sourceId: string;
  rings: Ring[];
}

export interface Pile {
  id: string;
  m: number;
  bbox: [number, number, number, number];
  agreementByK: Record<string, AgreementLevel>;
  sourceRings: SourceRings[];
}

export interface AnalyzeData {
  setId: string;
  displayName: string;
  imageHash: string;
  imageWidth: number;
  imageHeight: number;
  mTotal: number;
  piles: Pile[];
}

export interface PairSummary {
  id: string;
  display_name: string;
  kind: 'raw' | 'merged' | 'reannotated';
  image_hash: string;
  image_ext: string;
  shape_count: number;
  pile_count: number | null;
  terminal: boolean;
  created_by: string;
  created_at: string;
  uploaded_at: string;
}

export interface Filters {
  kMin: number;
  kAgree: number;
  iouFilter: number;
  mode: Mode;
}

export interface VisiblePileResult {
  pile: Pile;
  lookupK: number;
  fraction: number;
}
