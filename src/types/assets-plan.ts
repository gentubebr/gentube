export type ShotType = "image" | "video";
export type IpRisk = "none" | "low" | "high";
export type ShotSource = "ai_generated" | "stock";

export type ShotPlan = {
  id: string;
  type: ShotType;
  source: ShotSource;
  role: string;
  duration_seconds_max: number;
  description: string;
  negative_prompt?: string;
  search_keywords?: string | null;
  aligns_with_excerpt: string;
  ip_risk: IpRisk;
  character_required?: boolean;
};

export type BlockAssetsPlan = {
  schema_version: string;
  block_number: number;
  shots: ShotPlan[];
};
