import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { buildChatResponse } from '../domain/buildChatResponse.js';
import { buildImageRequest } from '../domain/buildImageRequest.js';
import { buildImageEditsForm } from '../domain/buildImageEditsRequest.js';
import {
  buildStreamContentChunk,
  buildStreamDoneChunk,
  buildStreamHeartbeatChunk,
  buildStreamProgressChunk,
  buildStreamRoleChunk,
  buildStreamStopChunk,
  buildStreamThinkCloseChunk,
  buildStreamThinkOpenChunk
} from '../domain/buildStreamResponse.js';
import { detectImageIntent } from '../domain/detectImageIntent.js';
import { extractImageInput } from '../domain/extractImageInput.js';
import { extractPrompt } from '../domain/extractPrompt.js';
import { BadRequestError, HttpError, UpstreamError } from '../http/errors.js';
import { createRequestId, sendOpenAiError } from '../http/openaiResponses.js';
import { chatCompletionsRequestSchema, type ChatCompletionsRequest } from '../openai/chatSchemas.js';
import type { OpenAiClient } from '../openai/client.js';
import type { LocalFileStore } from '../storage/localFileStore.js';
import { createChatCompletionId } from '../utils/id.js';
import { unixTimestampSeconds } from '../utils/time.js';

const STREAM_HEARTBEAT_INTERVAL_MS = 15000;

export async function registerChatCompletionsRoute(
  app: FastifyInstance,
  config: AppConfig,
  openAiClient: OpenAiClient,
  fileStore: LocalFileStore
): Promise<void> {
  app.post<{ Body: ChatCompletionsRequest }>('/v1/chat/completions', async (request, reply) => {
    const requestId = request.headers['x-request-id']?.toString() ?? createRequestId();
    reply.header('x-request-id', requestId);

    const parsed = chatCompletionsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendOpenAiError(reply, requestId, new BadRequestError('Invalid chat completions request body', 'invalid_request_body'));
      return;
    }

    const body = parsed.data;

    if (body.tools !== undefined || body.tool_choice !== undefined || body.parallel_tool_calls !== undefined) {
      sendOpenAiError(
        reply,
        requestId,
        new BadRequestError('Tools are not supported for image proxy requests', 'unsupported_tools')
      );
      return;
    }

    if (!detectImageIntent(body.model, config)) {
      sendOpenAiError(
        reply,
        requestId,
        new BadRequestError('This proxy only supports configured image models via /v1/chat/completions', 'unsupported_model', 'model')
      );
      return;
    }

    const streamId = body.stream ? createChatCompletionId() : null;
    const created = body.stream ? unixTimestampSeconds() : null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let waitingForHeartbeatDrain = false;

    const handleHeartbeatDrain = (): void => {
      waitingForHeartbeatDrain = false;
      startHeartbeat();
    };

    const stopHeartbeat = (): void => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (waitingForHeartbeatDrain) {
        reply.raw.off('drain', handleHeartbeatDrain);
        waitingForHeartbeatDrain = false;
      }
    };

    const handleStreamClosed = (): void => {
      stopHeartbeat();
    };

    const bindStreamCleanup = (): void => {
      request.raw.once('aborted', handleStreamClosed);
      request.raw.once('close', handleStreamClosed);
      request.raw.once('error', handleStreamClosed);
      reply.raw.once('close', handleStreamClosed);
      reply.raw.once('error', handleStreamClosed);
    };

    const unbindStreamCleanup = (): void => {
      request.raw.off('aborted', handleStreamClosed);
      request.raw.off('close', handleStreamClosed);
      request.raw.off('error', handleStreamClosed);
      reply.raw.off('close', handleStreamClosed);
      reply.raw.off('error', handleStreamClosed);
    };

    const pauseHeartbeatUntilDrain = (): void => {
      stopHeartbeat();
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        return;
      }
      waitingForHeartbeatDrain = true;
      reply.raw.once('drain', handleHeartbeatDrain);
    };

    const startHeartbeat = (): void => {
      if (heartbeatTimer || waitingForHeartbeatDrain) {
        return;
      }
      heartbeatTimer = setInterval(() => {
        if (reply.raw.writableEnded || reply.raw.destroyed) {
          stopHeartbeat();
          return;
        }
        if (!reply.raw.write(buildStreamHeartbeatChunk())) {
          pauseHeartbeatUntilDrain();
        }
      }, STREAM_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref();
    };

    try {
      const prompt = extractPrompt(body, config.maxPromptChars);
      const imageInput = extractImageInput(body);

      if (body.stream && streamId && created) {
        bindStreamCleanup();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'x-request-id': requestId
        });
        reply.raw.write(buildStreamRoleChunk(streamId, created, body.model));
        reply.raw.write(buildStreamThinkOpenChunk(streamId, created, body.model));
        reply.raw.write(buildStreamProgressChunk(streamId, created, body.model, 'accepted', config.streamProgressLanguage));
        reply.raw.write(buildStreamProgressChunk(streamId, created, body.model, 'generating', config.streamProgressLanguage));
        startHeartbeat();
      }

      const imageResponse = imageInput
        ? await openAiClient.editImage(await buildImageEditsForm(body, prompt, imageInput, config.remoteImageUrlPolicy))
        : await openAiClient.generateImage(buildImageRequest(body, prompt));
      const imageData = imageResponse.data[0];
      if (!imageData) {
        throw new UpstreamError(502, 'Upstream returned no image data', 'upstream_empty_response');
      }

      if (body.stream && streamId && created) {
        reply.raw.write(buildStreamProgressChunk(streamId, created, body.model, 'saving', config.streamProgressLanguage));
      }

      const storeContext = { model: body.model, prompt, producer: 'chat' as const };
      const storedImage = imageData.b64_json
        ? await fileStore.saveBase64Image(imageData.b64_json, 'png', storeContext)
        : imageData.url
          ? await fileStore.saveRemoteImage(imageData.url, storeContext)
          : (() => {
              throw new UpstreamError(502, 'Upstream returned neither b64_json nor url', 'upstream_invalid_payload');
            })();

      if (body.stream && streamId && created) {
        stopHeartbeat();
        reply.raw.write(buildStreamProgressChunk(streamId, created, body.model, 'completed', config.streamProgressLanguage));
        reply.raw.write(buildStreamThinkCloseChunk(streamId, created, body.model));
        reply.raw.write(buildStreamContentChunk(streamId, created, body.model, `![generated image](${storedImage.publicUrl})`));
        reply.raw.write(buildStreamStopChunk(streamId, created, body.model));
        reply.raw.end(buildStreamDoneChunk());
        return reply;
      }

      return buildChatResponse(body.model, storedImage.publicUrl);
    } catch (error) {
      const mappedError = mapToHttpError(error);

      if (body.stream && streamId && created) {
        if (!reply.raw.headersSent) {
          bindStreamCleanup();
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'x-request-id': requestId
          });
          reply.raw.write(buildStreamRoleChunk(streamId, created, body.model));
          reply.raw.write(buildStreamThinkOpenChunk(streamId, created, body.model));
          reply.raw.write(buildStreamProgressChunk(streamId, created, body.model, 'accepted', config.streamProgressLanguage));
        }
        stopHeartbeat();
        reply.raw.write(buildStreamThinkCloseChunk(streamId, created, body.model));
        reply.raw.write(buildStreamContentChunk(streamId, created, body.model, `Error: ${mappedError.message}`));
        reply.raw.write(buildStreamStopChunk(streamId, created, body.model));
        reply.raw.end(buildStreamDoneChunk());
        return reply;
      }

      sendOpenAiError(reply, requestId, mappedError);
    } finally {
      stopHeartbeat();
      unbindStreamCleanup();
    }
  });
}

function mapToHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';

  if (message.includes('MAX_PROMPT_CHARS')) {
    return new BadRequestError(message, 'prompt_too_long', 'messages');
  }

  if (message.includes('No user prompt')) {
    return new BadRequestError(message, 'missing_prompt', 'messages');
  }

  if (message.includes('Only n=1')) {
    return new BadRequestError(message, 'unsupported_n', 'n');
  }

  if (message.includes('Image input data URL')) {
    return new BadRequestError(message, 'invalid_image_input', 'messages');
  }

  if (message.includes('timed out')) {
    return new UpstreamError(504, message, 'upstream_timeout');
  }

  if (message.includes('Upstream') || message.includes('Failed to download upstream image')) {
    return new UpstreamError(502, message, 'upstream_error');
  }

  return new UpstreamError(500, message, 'internal_error');
}
