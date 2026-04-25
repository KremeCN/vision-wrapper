import { BadRequestError } from '../http/errors.js';
import type { RemoteImageUrlPolicy } from '../config.js';
import type { ExtractedImageInput } from './extractImageInput.js';
import type { ChatCompletionsRequest } from '../openai/chatSchemas.js';
import { safeDownload } from '../security/safeFetch.js';
import { assertSafeClientImageUrl } from '../security/safeExternalUrl.js';

type BuiltImageEditsForm = {
  formData: FormData;
};

const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]*)$/i;

export async function buildImageEditsForm(
  request: ChatCompletionsRequest,
  prompt: string,
  imageInput: ExtractedImageInput,
  remoteImageUrlPolicy: RemoteImageUrlPolicy
): Promise<BuiltImageEditsForm> {
  if (request.n !== undefined && request.n !== 1) {
    throw new Error('Only n=1 is supported');
  }

  const formData = new FormData();
  formData.set('model', request.model);
  formData.set('prompt', prompt);
  formData.set('image', await imageInputToFile(imageInput, remoteImageUrlPolicy));

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

async function imageInputToFile(imageInput: ExtractedImageInput, remoteImageUrlPolicy: RemoteImageUrlPolicy): Promise<File> {
  if (imageInput.kind === 'remote_url') {
    return remoteImageUrlToFile(imageInput.imageUrl, remoteImageUrlPolicy);
  }

  return dataUrlToFile(imageInput.dataUrl);
}

async function remoteImageUrlToFile(imageUrl: string, remoteImageUrlPolicy: RemoteImageUrlPolicy): Promise<File> {
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

function dataUrlToFile(dataUrl: string): File {
  const match = DATA_URL_PATTERN.exec(dataUrl.trim());
  const mimeType = match?.[1];
  const encodedBody = match?.[2];
  if (!mimeType || encodedBody === undefined) {
    throw new BadRequestError('Image input data URL must be a valid base64 data URL', 'invalid_image_input', 'messages');
  }

  const normalizedMimeType = mimeType.toLowerCase();
  if (!normalizedMimeType.startsWith('image/')) {
    throw new BadRequestError('Image input data URL must use an image content-type', 'invalid_image_input', 'messages');
  }

  if (encodedBody.length === 0) {
    throw new BadRequestError('Image input data URL is empty', 'invalid_image_input', 'messages');
  }

  const base64Body = encodedBody.replace(/\s+/g, '');
  if (!base64Body) {
    throw new BadRequestError('Image input data URL is empty', 'invalid_image_input', 'messages');
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64Body, 'base64');
  } catch {
    throw new BadRequestError('Image input data URL must be a valid base64 data URL', 'invalid_image_input', 'messages');
  }

  if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/, '') !== base64Body.replace(/=+$/, '')) {
    throw new BadRequestError('Image input data URL must be a valid base64 data URL', 'invalid_image_input', 'messages');
  }

  const arrayBuffer = new ArrayBuffer(bytes.length);
  new Uint8Array(arrayBuffer).set(bytes);
  return new File([arrayBuffer], `image${contentTypeToExtension(normalizedMimeType)}`, { type: normalizedMimeType });
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
