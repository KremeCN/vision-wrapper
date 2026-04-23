import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { AuthenticationError } from '../http/errors.js';
import { createRequestId, sendOpenAiError } from '../http/openaiResponses.js';

function isPublicRoute(request: FastifyRequest): boolean {
  return request.routeOptions.url === '/files/*';
}

export function createAuthPreHandler(config: AppConfig) {
  return async function authPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.method === 'OPTIONS' || isPublicRoute(request)) {
      return;
    }

    const requestId = request.headers['x-request-id']?.toString() ?? createRequestId();
    reply.header('x-request-id', requestId);

    const authorization = request.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      sendOpenAiError(reply, requestId, new AuthenticationError('Missing bearer token', 'missing_bearer_token'));
      return;
    }

    const token = authorization.slice('Bearer '.length).trim();
    if (!config.proxyApiKeys.has(token)) {
      sendOpenAiError(reply, requestId, new AuthenticationError('Invalid bearer token', 'invalid_bearer_token'));
      return;
    }
  };
}
