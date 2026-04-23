export type ImagesGenerationRequest = {
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  background?: string;
  n?: number;
};

export type ImagesEditsRequest = {
  model: string;
  prompt: string;
  image: string;
  size?: string;
  quality?: string;
  background?: string;
  n?: number;
};

export type ImagesGenerationResponse = {
  created?: number;
  data: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
};
