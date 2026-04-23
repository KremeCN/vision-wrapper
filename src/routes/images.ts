import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { BadRequestError, HttpError, UpstreamError } from '../http/errors.js';
import { createRequestId, sendOpenAiError } from '../http/openaiResponses.js';
import type { OpenAiClient } from '../openai/client.js';

type SupportedImageOperation = 'generations' | 'edits';

type MultipartPart = {
  headers: Record<string, string>;
  body: Buffer;
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

function parseMultipartModel(rawBody: Buffer, boundary: string): string | null {
  const parts = parseMultipartParts(rawBody, boundary);
  for (const part of parts) {
    const disposition = part.headers['content-disposition'];
    if (!disposition || parseContentDispositionName(disposition) !== 'model') {
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

function validateMultipartModel(rawBody: Buffer, contentType: string, expectedModel: string): HttpError | null {
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) {
    return new BadRequestError('Missing multipart boundary', 'invalid_multipart_boundary', 'model');
  }

  const model = parseMultipartModel(rawBody, boundary);
  if (!model) {
    return null;
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

export async function registerImagesRoutes(
  app: FastifyInstance,
  config: AppConfig,
  openAiClient: OpenAiClient
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
      const upstream = await openAiClient.forwardImagesRequest(operation, {
        body: isMultipart ? multipartBody ?? Buffer.alloc(0) : request.body,
        contentType
      });

      reply.code(upstream.statusCode);
      reply.header('content-type', upstream.contentType);
      reply.send(upstream.body);
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

  if (message.includes('Upstream')) {
    return new UpstreamError(502, message, 'upstream_error');
  }

  return new UpstreamError(502, message, 'upstream_forward_error');
}
