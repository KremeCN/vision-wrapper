import type { ChatCompletionsRequest, ChatMessageContentPart } from '../openai/chatSchemas.js';

const INLINE_DATA_URL_PREFIX_PATTERN = /^data:image\//i;

export type ExtractedImageInput =
  | {
      kind: 'remote_url';
      imageUrl: string;
    }
  | {
      kind: 'inline_data_url';
      dataUrl: string;
    };

function getImageUrlFromPart(part: ChatMessageContentPart): string | null {
  if (part.type !== 'image_url') {
    return null;
  }

  const imageUrl = (part as { image_url?: unknown }).image_url;
  if (typeof imageUrl === 'string' && imageUrl.trim()) {
    return imageUrl.trim();
  }

  if (
    imageUrl &&
    typeof imageUrl === 'object' &&
    'url' in imageUrl &&
    typeof (imageUrl as { url?: unknown }).url === 'string'
  ) {
    const url = (imageUrl as { url: string }).url.trim();
    return url || null;
  }

  return null;
}

export function extractImageInput(request: ChatCompletionsRequest): ExtractedImageInput | null {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];

    if (!message || message.role !== 'user' || typeof message.content === 'string') {
      continue;
    }

    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex];
      if (!part) {
        continue;
      }
      const imageUrl = getImageUrlFromPart(part);
      if (!imageUrl) {
        continue;
      }
      if (INLINE_DATA_URL_PREFIX_PATTERN.test(imageUrl)) {
        return { kind: 'inline_data_url', dataUrl: imageUrl };
      }
      return { kind: 'remote_url', imageUrl };
    }
  }

  return null;
}
