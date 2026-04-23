import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import { OpenAiClient } from './openai/client.js';
import { registerCors } from './plugins/cors.js';
import { registerHealthRoute } from './routes/health.js';
import { registerChatCompletionsRoute } from './routes/chatCompletions.js';
import { registerStaticFileRoutes } from './routes/staticFiles.js';
import { registerModelsRoute } from './routes/models.js';
import { registerImagesRoutes } from './routes/images.js';
import { createAuthPreHandler } from './security/auth.js';
import { registerRateLimit } from './security/rateLimit.js';
import Fastify from 'fastify';
import { FileMetadataStore } from './storage/fileMetadataStore.js';
import { LocalFileStore } from './storage/localFileStore.js';

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization']
    },
    bodyLimit: config.bodyLimitBytes
  });

  app.addContentTypeParser(/^multipart\/form-data(?:;.*)?$/i, { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  const openAiClient = new OpenAiClient(config.upstreamBaseUrl, config.upstreamApiKey, config.requestTimeoutMs);
  const metadataStore = new FileMetadataStore({ rootDir: config.imageStorageDir });
  const fileStore = new LocalFileStore({
    rootDir: config.imageStorageDir,
    publicBaseUrl: config.publicBaseUrl,
    metadataStore
  });

  await metadataStore.cleanupExpired(config.fileTtlHours);
  await registerCors(app, config);
  await registerRateLimit(app, config);
  app.addHook('preHandler', createAuthPreHandler(config));
  await registerHealthRoute(app, config);
  await registerModelsRoute(app, config);
  await registerChatCompletionsRoute(app, config, openAiClient, fileStore);
  await registerImagesRoutes(app, config, openAiClient);
  await registerStaticFileRoutes(app, fileStore);

  return app;
}
