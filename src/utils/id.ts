import { randomUUID } from 'node:crypto';

export function createChatCompletionId(): string {
  return `chatcmpl_${randomUUID().replaceAll('-', '')}`;
}

export function createFileId(): string {
  return randomUUID().replaceAll('-', '');
}
