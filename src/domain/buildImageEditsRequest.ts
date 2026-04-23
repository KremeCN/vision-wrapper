import type { RemoteImageUrlPolicy } from '../config.js';
import type { ChatCompletionsRequest } from '../openai/chatSchemas.js';
import { safeDownload } from '../security/safeFetch.js';
import { assertSafeClientImageUrl } from '../security/safeExternalUrl.js';

type BuiltImageEditsForm = {
  formData: FormData;
};

export async function buildImageEditsForm(
  request: ChatCompletionsRequest,
  prompt: string,
  imageUrl: string,
  remoteImageUrlPolicy: RemoteImageUrlPolicy
): Promise<BuiltImageEditsForm> {
  if (request.n !== undefined && request.n !== 1) {
    throw new Error('Only n=1 is supported');
  }

  const formData = new FormData();
  formData.set('model', request.model);
  formData.set('prompt', prompt);
  formData.set('image', await imageUrlToFile(imageUrl, remoteImageUrlPolicy));

  if (request.size) {
    formData.set('size', request.size);
  }

  if (request.quality) {
    formData.set('quality', request.quality);
  }

  if (request.background) {
    formData.set('background', request.background);
  }

  formData.set('n', '1');

  return { formData };
}

async function imageUrlToFile(imageUrl: string, remoteImageUrlPolicy: RemoteImageUrlPolicy): Promise<File> {
  const safeUrl = await assertSafeClientImageUrl(imageUrl, { policy: remoteImageUrlPolicy });
  const response = await safeDownload(safeUrl);
  if (!response.ok) {
    throw new Error(`Failed to download upstream image input (${response.status})`);
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Image input URL must return an image content-type (received ${contentType})`);
  }

  const bytes = await response.arrayBuffer();
  return new File([bytes], inferFilename(safeUrl.url, contentType), { type: contentType });
}

function inferFilename(imageUrl: URL, contentType: string): string {
  const segment = imageUrl.pathname.split('/').filter(Boolean).pop();
  if (segment && segment.includes('.')) {
    return segment;
  }

  const extension = contentTypeToExtension(contentType);
  return `image${extension}`;
}

function contentTypeToExtension(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.bin';
  }
}
