import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { BadRequestError, HttpError } from '../http/errors.js';
import { createRequestId, sendOpenAiError } from '../http/openaiResponses.js';
import type { OpenAiClient } from '../openai/client.js';

type SupportedImageOperation = 'generations' | 'edits';

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
  const match = contentType.match(/boundary=(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function parseMultipartModel(rawBody: Buffer, boundary: string): string | null {
  const content = rawBody.toString('latin1');
  const parts = content.split(`--${boundary}`);
  for (const part of parts) {
    if (!part.includes('name="model"')) {
      continue;
    }
    const contentSplit = part.split('\r\n\r\n');
    if (contentSplit.length < 2) {
      continue;
    }
    return contentSplit[1]?.replace(/\r\n--?$/, '').trim() ?? null;
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
  return new BadRequestError(message, 'upstream_forward_error');
}
