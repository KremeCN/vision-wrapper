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
      const auth = request.headers.authorization?.trim();
      return auth || request.ip;
    },
    allowList(request) {
      return isPublicRoute(request);
    },
    errorResponseBuilder() {
      return buildOpenAiErrorBody(new RateLimitError());
    }
  });
}
