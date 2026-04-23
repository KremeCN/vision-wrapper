import type { ChatCompletionsRequest } from '../openai/chatSchemas.js';

type BuiltImageEditsForm = {
  formData: FormData;
};

export async function buildImageEditsForm(
  request: ChatCompletionsRequest,
  prompt: string,
  imageUrl: string
): Promise<BuiltImageEditsForm> {
  if (request.n !== undefined && request.n !== 1) {
    throw new Error('Only n=1 is supported');
  }

  const formData = new FormData();
  formData.set('model', request.model);
  formData.set('prompt', prompt);
  formData.set('image', await imageUrlToFile(imageUrl));

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

async function imageUrlToFile(imageUrl: string): Promise<File> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download upstream image input (${response.status})`);
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  const bytes = await response.arrayBuffer();
  return new File([bytes], inferFilename(imageUrl, contentType), { type: contentType });
}

function inferFilename(imageUrl: string, contentType: string): string {
  try {
    const pathname = new URL(imageUrl).pathname;
    const segment = pathname.split('/').filter(Boolean).pop();
    if (segment && segment.includes('.')) {
      return segment;
    }
  } catch {
    // ignore invalid URL here; fetch will surface the actual problem
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
