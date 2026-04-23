import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

const ALLOWED_METHODS = 'GET,POST,OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type, X-Request-Id';

function applyCorsHeaders(app: FastifyInstance, config: AppConfig): void {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', config.corsAllowOrigin);
    reply.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    reply.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
  });
}

export async function registerCors(app: FastifyInstance, config: AppConfig): Promise<void> {
  applyCorsHeaders(app, config);

  app.options('/healthz', async (_request, reply) => {
    reply.code(204).send();
  });

  app.options('/v1/models', async (_request, reply) => {
    reply.code(204).send();
  });

  app.options('/v1/models/:id', async (_request, reply) => {
    reply.code(204).send();
  });

  app.options('/v1/chat/completions', async (_request, reply) => {
    reply.code(204).send();
  });

  app.options('/v1/images/generations', async (_request, reply) => {
    reply.code(204).send();
  });

  app.options('/v1/images/edits', async (_request, reply) => {
    reply.code(204).send();
  });

  app.options('/files/*', async (_request, reply) => {
    reply.code(204).send();
  });
}
