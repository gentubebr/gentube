export type QuoteType = "biblical" | "philosophical" | "impact_phrase" | "rhetorical_question";

export type QuoteOverlayStyle = "quote_card" | "impact" | "attribution";

export type BlockQuote = {
  id: string;
  type: QuoteType;
  starts_with: string;
  ends_with: string;
  reference?: string;
  overlay_style: QuoteOverlayStyle;
};

export type BlockQuotesPlan = {
  schema_version: "1.0-quotes";
  stage: "quotizador";
  block_number: number;
  total_blocks: number;
  quotes: BlockQuote[];
};

export type QuoteOverlay = {
  quote_id: string;
  text: string;
  reference?: string;
  start_time_seconds: number;
  end_time_seconds: number;
  overlay_style: QuoteOverlayStyle;
};

export type SceneAlignmentFile = {
  alignment: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  };
};
