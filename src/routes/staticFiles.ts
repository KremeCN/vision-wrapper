import type { FastifyInstance } from 'fastify';
import type { LocalFileStore } from '../storage/localFileStore.js';

export async function registerStaticFileRoutes(app: FastifyInstance, fileStore: LocalFileStore): Promise<void> {
  app.get('/files/*', async (request, reply) => {
    const wildcard = (request.params as { '*': string })['*'];

    if (!wildcard) {
      reply.code(404).send({ error: { message: 'File not found' } });
      return;
    }

    try {
      const file = await fileStore.readFileById(wildcard);
      reply.header('content-type', file.mimeType);
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      reply.send(file.buffer);
    } catch {
      reply.code(404).send({ error: { message: 'File not found' } });
    }
  });
}
