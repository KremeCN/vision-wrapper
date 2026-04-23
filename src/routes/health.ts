import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

export async function registerHealthRoute(app: FastifyInstance, _config: AppConfig): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));
}
