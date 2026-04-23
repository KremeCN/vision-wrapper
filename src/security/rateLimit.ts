import { createHash } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { RateLimitError } from '../http/errors.js';
import { buildOpenAiErrorBody } from '../http/openaiResponses.js';

function isPublicRoute(request: FastifyRequest): boolean {
  return request.routeOptions.url === '/files/*';
}

export async function registerRateLimit(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    keyGenerator(request) {
      const token = extractBearerToken(request.headers.authorization);
      return token ? `token:${hashToken(token)}` : request.ip;
    },
    allowList(request) {
      return isPublicRoute(request);
    },
    errorResponseBuilder() {
      return buildOpenAiErrorBody(new RateLimitError());
    }
  });
}

function extractBearerToken(authorization?: string): string | null {
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
