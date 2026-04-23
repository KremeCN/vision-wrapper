import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { RateLimitError } from '../http/errors.js';
import { buildOpenAiErrorBody } from '../http/openaiResponses.js';

function isPublicPath(pathname: string): boolean {
  return pathname.startsWith('/files/');
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
      return isPublicPath(request.url);
    },
    errorResponseBuilder() {
      return buildOpenAiErrorBody(new RateLimitError());
    }
  });
}
