import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { HttpError } from './errors.js';

export type OpenAiErrorBody = {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
};

export function createRequestId(): string {
  return `req_${randomUUID().replaceAll('-', '')}`;
}

export function buildOpenAiErrorBody(error: HttpError): OpenAiErrorBody {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param ?? null,
      code: error.code ?? null
    }
  };
}

export function sendOpenAiError(reply: FastifyReply, requestId: string, error: HttpError): FastifyReply {
  reply.header('x-request-id', requestId);
  return reply.code(error.statusCode).send(buildOpenAiErrorBody(error));
}

export function buildSseErrorPayload(error: HttpError): string {
  return `data: ${JSON.stringify(buildOpenAiErrorBody(error))}\n\ndata: [DONE]\n\n`;
}
