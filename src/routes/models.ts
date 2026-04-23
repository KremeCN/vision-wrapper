import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { NotFoundError } from '../http/errors.js';
import { createRequestId, sendOpenAiError } from '../http/openaiResponses.js';

type ModelResponse = {
  id: string;
  object: 'model';
  created: number;
  owned_by: 'vision-wrapper';
};

function buildModelResponse(modelId: string): ModelResponse {
  return {
    id: modelId,
    object: 'model',
    created: 0,
    owned_by: 'vision-wrapper'
  };
}

export async function registerModelsRoute(app: FastifyInstance, config: AppConfig): Promise<void> {
  app.get('/v1/models', async (request, reply) => {
    const requestId = request.headers['x-request-id']?.toString() ?? createRequestId();
    reply.header('x-request-id', requestId);

    return {
      object: 'list',
      data: Array.from(config.imageModelAliases).map(buildModelResponse)
    };
  });

  app.get<{ Params: { id: string } }>('/v1/models/:id', async (request, reply) => {
    const requestId = request.headers['x-request-id']?.toString() ?? createRequestId();
    reply.header('x-request-id', requestId);

    const modelId = request.params.id;

    if (!config.imageModelAliases.has(modelId)) {
      sendOpenAiError(reply, requestId, new NotFoundError(`Model '${modelId}' not found`, 'model_not_found'));
      return;
    }

    return buildModelResponse(modelId);
  });
}
