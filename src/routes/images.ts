import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { BadRequestError, HttpError, UpstreamError } from '../http/errors.js';
import { createRequestId, sendOpenAiError } from '../http/openaiResponses.js';
import type { OpenAiClient } from '../openai/client.js';
import type { LocalFileStore } from '../storage/localFileStore.js';

type SupportedImageOperation = 'generations' | 'edits';

type MultipartPart = {
  headers: Record<string, string>;
  body: Buffer;
};

type NativeImagesResponse = {
  created?: number | undefined;
  data?: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
};

function isSupportedOperation(operation: string): operation is SupportedImageOperation {
  return operation === 'generations' || operation === 'edits';
}

function getSingleModelAlias(config: AppConfig): string {
  return Array.from(config.imageModelAliases)[0] as string;
}

function validateModelAlias(body: unknown, expectedModel: string): HttpError | null {
  if (!body || typeof body !== 'object' || !('model' in body)) {
    return null;
  }

  const model = (body as { model?: unknown }).model;
  if (typeof model !== 'string' || model.trim().length === 0) {
    return new BadRequestError('Model must be a non-empty string', 'invalid_model', 'model');
  }

  if (model !== expectedModel) {
    return new BadRequestError(
      `This proxy only exposes '${expectedModel}' for image endpoints`,
      'unsupported_model',
      'model'
    );
  }

  return null;
}

function parseMultipartBoundary(contentType: string): string | null {
  for (const segment of contentType.split(';').slice(1)) {
    const [rawKey, ...rawValueParts] = segment.split('=');
    if (!rawKey || rawValueParts.length === 0) {
      continue;
    }

    if (rawKey.trim().toLowerCase() !== 'boundary') {
      continue;
    }

    const rawValue = rawValueParts.join('=').trim();
    const unquoted = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
    return unquoted || null;
  }

  return null;
}

function parseMultipartField(rawBody: Buffer, boundary: string, fieldName: string): string | null {
  const parts = parseMultipartParts(rawBody, boundary);
  for (const part of parts) {
    const disposition = part.headers['content-disposition'];
    if (!disposition || parseContentDispositionName(disposition) !== fieldName) {
      continue;
    }

    return part.body.toString('utf8').trim() || null;
  }

  return null;
}

function parseMultipartParts(rawBody: Buffer, boundary: string): MultipartPart[] {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const delimiterBuffer = Buffer.from(`\r\n--${boundary}`);
  const headerSeparatorBuffer = Buffer.from('\r\n\r\n');
  const closingSuffixBuffer = Buffer.from('--');
  const parts: MultipartPart[] = [];

  let cursor = 0;
  if (!rawBody.subarray(0, boundaryBuffer.length).equals(boundaryBuffer)) {
    return parts;
  }
  cursor = boundaryBuffer.length;

  while (cursor < rawBody.length) {
    if (rawBody.subarray(cursor, cursor + 2).equals(closingSuffixBuffer)) {
      break;
    }

    if (rawBody.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) {
      cursor += 2;
    }

    const headerEnd = rawBody.indexOf(headerSeparatorBuffer, cursor);
    if (headerEnd === -1) {
      break;
    }

    const headers = parsePartHeaders(rawBody.subarray(cursor, headerEnd).toString('utf8'));
    const bodyStart = headerEnd + headerSeparatorBuffer.length;
    const nextDelimiter = rawBody.indexOf(delimiterBuffer, bodyStart);
    if (nextDelimiter === -1) {
      break;
    }

    const body = rawBody.subarray(bodyStart, nextDelimiter);
    parts.push({ headers, body });
    cursor = nextDelimiter + delimiterBuffer.length;
  }

  return parts;
}

function parsePartHeaders(rawHeaders: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of rawHeaders.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key) {
      headers[key] = value;
    }
  }
  return headers;
}

function parseContentDispositionName(disposition: string): string | null {
  for (const segment of disposition.split(';').slice(1)) {
    const [rawKey, ...rawValueParts] = segment.split('=');
    if (!rawKey || rawValueParts.length === 0) {
      continue;
    }

    if (rawKey.trim().toLowerCase() !== 'name') {
      continue;
    }

    const rawValue = rawValueParts.join('=').trim();
    const unquoted = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
    return unquoted || null;
  }

  return null;
}

function parseMultipartModel(rawBody: Buffer, boundary: string): string | null {
  return parseMultipartField(rawBody, boundary, 'model');
}

function extractMultipartPrompt(rawBody: Buffer, contentType: string): string {
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) {
    return '';
  }

  return parseMultipartField(rawBody, boundary, 'prompt') ?? '';
}

function validateMultipartModel(rawBody: Buffer, contentType: string, expectedModel: string): HttpError | null {
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) {
    return new BadRequestError('Missing multipart boundary', 'invalid_multipart_boundary', 'model');
  }

  const model = parseMultipartModel(rawBody, boundary);
  if (!model) {
    return new BadRequestError('Multipart form-data must include a valid model field', 'invalid_multipart_model', 'model');
  }

  if (model !== expectedModel) {
    return new BadRequestError(
      `This proxy only exposes '${expectedModel}' for image endpoints`,
      'unsupported_model',
      'model'
    );
  }

  return null;
}


function normalizeMultipartLineEndings(value: string): string {
  return value.replace(/\r?\n/g, '\r\n');
}

function extractContentDispositionFilename(disposition: string): string | null {
  for (const segment of disposition.split(';').slice(1)) {
    const [rawKey, ...rawValueParts] = segment.split('=');
    if (!rawKey || rawValueParts.length === 0) {
      continue;
    }

    if (rawKey.trim().toLowerCase() !== 'filename') {
      continue;
    }

    const rawValue = rawValueParts.join('=').trim();
    const unquoted = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
    return unquoted || null;
  }

  return null;
}

function replaceContentDispositionFilename(disposition: string, filename: string): string {
  const replacement = `filename="${filename}"`;
  if (/;\s*filename=/i.test(disposition)) {
    return disposition.replace(/filename=("[^"]*"|[^;]+)/i, replacement);
  }
  return `${disposition}; ${replacement}`;
}

function replaceOrAppendHeader(headers: Record<string, string>, key: string, value: string): Record<string, string> {
  return {
    ...headers,
    [key.toLowerCase()]: value
  };
}

function serializeMultipartPart(part: MultipartPart): Buffer {
  const headerLines = Object.entries(part.headers).map(([key, value]) => `${key}: ${normalizeMultipartLineEndings(value).replace(/\r\n/g, ' ')}`);
  return Buffer.concat([
    Buffer.from(`${headerLines.join('\r\n')}\r\n\r\n`, 'utf8'),
    part.body
  ]);
}

function serializeMultipartBody(parts: MultipartPart[], boundary: string): Buffer {
  const serializedParts = parts.flatMap((part) => [
    Buffer.from(`--${boundary}\r\n`, 'utf8'),
    serializeMultipartPart(part),
    Buffer.from('\r\n', 'utf8')
  ]);

  serializedParts.push(Buffer.from(`--${boundary}--`, 'utf8'));
  return Buffer.concat(serializedParts);
}

function isPngBuffer(buffer: Buffer): boolean {
  return buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
}

function isImagePart(part: MultipartPart): boolean {
  const disposition = part.headers['content-disposition'];
  return Boolean(disposition && parseContentDispositionName(disposition) === 'image');
}

function toPngFilename(filename: string | null): string {
  if (!filename) {
    return 'image.png';
  }

  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) {
    return `${filename}.png`;
  }

  return `${filename.slice(0, lastDot)}.png`;
}

async function normalizeMultipartImagePartToPng(part: MultipartPart): Promise<MultipartPart> {
  if (isPngBuffer(part.body)) {
    return part;
  }

  try {
    const pngBody = await sharp(part.body).png().toBuffer();
    const disposition = part.headers['content-disposition'];
    const nextDisposition = disposition
      ? replaceContentDispositionFilename(disposition, toPngFilename(extractContentDispositionFilename(disposition)))
      : disposition;

    return {
      headers: {
        ...replaceOrAppendHeader(part.headers, 'content-type', 'image/png'),
        ...(nextDisposition ? { 'content-disposition': nextDisposition } : {})
      },
      body: pngBody
    };
  } catch {
    throw new BadRequestError('Image upload must be a valid decodable image when PNG normalization is enabled', 'invalid_image_input', 'image');
  }
}

async function normalizeMultipartEditsBodyToPng(rawBody: Buffer, contentType: string): Promise<Buffer> {
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) {
    throw new BadRequestError('Missing multipart boundary', 'invalid_multipart_boundary', 'model');
  }

  const parts = parseMultipartParts(rawBody, boundary);
  if (parts.length === 0) {
    return rawBody;
  }

  const nextParts = await Promise.all(parts.map(async (part) => {
    if (!isImagePart(part)) {
      return part;
    }
    return normalizeMultipartImagePartToPng(part);
  }));

  return serializeMultipartBody(nextParts, boundary);
}

async function localizeImagesResponse(
  upstreamBody: unknown,
  model: string,
  prompt: string,
  fileStore: LocalFileStore
): Promise<NativeImagesResponse> {
  const response = upstreamBody as NativeImagesResponse;
  const imageItems = response.data;
  if (!Array.isArray(imageItems) || imageItems.length === 0) {
    throw new UpstreamError(502, 'Upstream returned no image data', 'upstream_empty_response');
  }

  return {
    created: response.created,
    data: await Promise.all(imageItems.map(async (imageItem) => {
      const storedImage = imageItem.b64_json
        ? await fileStore.saveBase64Image(imageItem.b64_json, 'png', { model, prompt, producer: 'native_images' })
        : imageItem.url
          ? await fileStore.saveRemoteImage(imageItem.url, { model, prompt, producer: 'native_images' })
          : (() => {
              throw new UpstreamError(502, 'Upstream returned neither b64_json nor url', 'upstream_invalid_payload');
            })();

      return imageItem.revised_prompt
        ? { url: storedImage.publicUrl, revised_prompt: imageItem.revised_prompt }
        : { url: storedImage.publicUrl };
    }))
  };
}

function extractPrompt(body: unknown): string {
  if (!body || typeof body !== 'object' || !('prompt' in body)) {
    return '';
  }

  const prompt = (body as { prompt?: unknown }).prompt;
  return typeof prompt === 'string' ? prompt : '';
}

export async function registerImagesRoutes(
  app: FastifyInstance,
  config: AppConfig,
  openAiClient: OpenAiClient,
  fileStore: LocalFileStore
): Promise<void> {
  app.post<{ Params: { operation: string }; Body: unknown }>('/v1/images/:operation', async (request, reply) => {
    const requestId = request.headers['x-request-id']?.toString() ?? createRequestId();
    reply.header('x-request-id', requestId);

    const operation = request.params.operation;
    if (!isSupportedOperation(operation)) {
      sendOpenAiError(reply, requestId, new BadRequestError('Unsupported image operation', 'unsupported_operation'));
      return;
    }

    const expectedModel = getSingleModelAlias(config);
    const contentType = request.headers['content-type']?.toString();
    const isMultipart = Boolean(contentType?.toLowerCase().includes('multipart/form-data'));
    const multipartBody = isMultipart ? (request.body as Buffer) : null;

    const modelError = isMultipart
      ? validateMultipartModel(multipartBody ?? Buffer.alloc(0), contentType as string, expectedModel)
      : validateModelAlias(request.body, expectedModel);

    if (modelError) {
      sendOpenAiError(reply, requestId, modelError);
      return;
    }

    try {
      const upstreamBody = isMultipart && operation === 'edits' && config.nativeImagesConvertInputToPng
        ? await normalizeMultipartEditsBodyToPng(multipartBody ?? Buffer.alloc(0), contentType as string)
        : isMultipart
          ? multipartBody ?? Buffer.alloc(0)
          : request.body;

      const upstream = await openAiClient.forwardImagesRequest(operation, {
        body: upstreamBody,
        contentType
      });

      const prompt = isMultipart
        ? extractMultipartPrompt(multipartBody ?? Buffer.alloc(0), contentType as string)
        : extractPrompt(request.body);

      const localized = await localizeImagesResponse(
        upstream.body,
        expectedModel,
        prompt,
        fileStore
      );

      reply.code(upstream.statusCode);
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.send(localized);
    } catch (error) {
      const mappedError = mapToHttpError(error);
      sendOpenAiError(reply, requestId, mappedError);
    }
  });
}

function mapToHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';

  if (message.includes('timed out')) {
    return new UpstreamError(504, message, 'upstream_timeout');
  }

  if (message.includes('fetch failed') || message.includes('network') || message.includes('socket') || message.includes('ECONN')) {
    return new UpstreamError(502, message, 'upstream_network_error');
  }

  if (message.includes('Upstream') || message.includes('Failed to download upstream image')) {
    return new UpstreamError(502, message, 'upstream_error');
  }

  return new UpstreamError(502, message, 'upstream_forward_error');
}
