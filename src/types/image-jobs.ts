export type ImageJobProvider = "higgsfield" | "gemini";
export type ImageJobDeliveryMode = "sync" | "google_batch" | "local_batch";
export type ImageJobOutcome = "pending" | "done" | "failed";

export type ImageJobRow = {
  id: number;
  project_id: number;
  block_number: number;
  shot_id: string;
  asset_type: "image";
  provider: ImageJobProvider;
  delivery_mode: ImageJobDeliveryMode;
  external_id: string | null;
  batch_id: string | null;
  out_path_no_ext: string;
  status: string;
  outcome: ImageJobOutcome;
  result_mime: string | null;
  error_message: string | null;
  reference_image_path: string | null;
  prompt_text: string | null;
  prompt_hash: string | null;
  downloaded_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ImageGenerationContext = {
  projectId: number;
  blockNumber: number;
  shotId: string;
  prompt: string;
  outPathNoExt: string;
  referenceImagePath?: string;
};
