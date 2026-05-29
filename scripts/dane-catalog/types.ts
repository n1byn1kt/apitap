// scripts/dane-catalog/types.ts

export interface Column {
  col: string;    // "col1"
  label: string;  // "IMIĘ_PIERWSZE"
  type: string;   // "string" | "integer" | ...
}

export interface ResourceEntry {
  resource_id: number;
  title: string;
  format: string;
  row_count: number;
  columns: Column[];
  sample_row: Record<string, string | number>;
  replay_example: string;
}

export interface DatasetEntry {
  dataset_id: number;
  title_pl: string;
  title_en_gloss: string;
  slug: string;
  url: string;
  keywords: string[];
  popularity: { views: number; downloads: number; openness: number };
  high_value: boolean;
  category_id: string;
  category_title_pl?: string;
  resources: ResourceEntry[];
  score: number;
}

export interface CategoryEntry {
  id: string;
  title_pl: string;
  title_en: string;
  datasets: DatasetEntry[];
}

export interface Catalog {
  source: string;
  generated_at: string;
  portal_totals: { datasets: number; resources: number; institutions: number };
  categories: CategoryEntry[];
}

// --- raw API shapes (only the fields we use) ---

export interface RawDataset {
  dataset_id: number;
  title_pl: string;
  slug: string;
  url: string;
  keywords: string[];
  views: number;
  downloads: number;
  openness: number;
  high_value: boolean;
  category_id: string;
  category_title_pl: string;
}

export interface RawResource {
  resource_id: number;
  title: string;
  format: string;
}

export interface ProbeResult {
  resource_id: number;
  ok: boolean;            // queryable
  row_count: number;
  columns: Column[];
  sample_row: Record<string, string | number>;
}

export interface Recipe {
  dataset_id: number;
  question: string;
  command: string;
  columns_meaning: string;
}
