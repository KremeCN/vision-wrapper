import type { ChatCompletionsRequest, ChatMessageContentPart } from '../openai/chatSchemas.js';

function hasText(part: ChatMessageContentPart): part is ChatMessageContentPart & { text: string } {
  return part.type === 'text' && typeof part.text === 'string';
}

function stringifyContentParts(parts: ChatMessageContentPart[]): string {
  return parts
    .filter(hasText)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n');
}

export function extractPrompt(request: ChatCompletionsRequest, maxPromptChars: number): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];

    if (!message || message.role !== 'user') {
      continue;
    }

    const content = typeof message.content === 'string'
      ? message.content.trim()
      : stringifyContentParts(message.content);

    if (!content) {
      continue;
    }

    if (content.length > maxPromptChars) {
      throw new Error(`Prompt exceeds MAX_PROMPT_CHARS (${maxPromptChars})`);
    }

    return content;
  }

  throw new Error('No user prompt found in messages');
}
