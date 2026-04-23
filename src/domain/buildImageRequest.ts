import type { ChatCompletionsRequest } from '../openai/chatSchemas.js';
import type { ImagesGenerationRequest } from '../openai/imageSchemas.js';

export function buildImageRequest(request: ChatCompletionsRequest, prompt: string): ImagesGenerationRequest {
  if (request.n !== undefined && request.n !== 1) {
    throw new Error('Only n=1 is supported');
  }

  return {
    model: request.model,
    prompt,
    ...(request.size ? { size: request.size } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    ...(request.background ? { background: request.background } : {}),
    n: 1
  };
}
