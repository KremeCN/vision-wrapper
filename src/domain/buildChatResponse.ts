import type { ChatCompletionResponse } from '../openai/chatSchemas.js';
import { createChatCompletionId } from '../utils/id.js';
import { unixTimestampSeconds } from '../utils/time.js';

export function buildChatResponse(model: string, imageUrl: string): ChatCompletionResponse {
  return {
    id: createChatCompletionId(),
    object: 'chat.completion',
    created: unixTimestampSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: `![generated image](${imageUrl})`
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}
