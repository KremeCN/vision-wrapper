export type StreamChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: 'stop' | null;
  }>;
};

export type StreamProgressLanguage = 'en' | 'zh';
export type StreamProgressStage = 'accepted' | 'generating' | 'saving' | 'completed';

const streamProgressMessages: Record<StreamProgressLanguage, Record<StreamProgressStage, string>> = {
  en: {
    accepted: '· Processing your image request.',
    generating: '✻ Generating the image with the upstream provider.',
    saving: '✽ Saving the generated image and preparing a public URL.',
    completed: '❋ Image is ready.'
  },
  zh: {
    accepted: '· 正在处理你的图片请求。',
    generating: '✻ 正在调用上游服务生成图片。',
    saving: '✽ 正在保存生成的图片并准备公开链接。',
    completed: '❋ 图片已准备完成。'
  }
};

function serializeChunk(chunk: StreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function buildStreamRoleChunk(id: string, created: number, model: string): string {
  return serializeChunk({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
  });
}

export function buildStreamContentChunk(id: string, created: number, model: string, content: string): string {
  return serializeChunk({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  });
}

export function buildStreamHeartbeatChunk(): string {
  return ': keep-alive\n\n';
}

export function buildStreamThinkOpenChunk(id: string, created: number, model: string): string {
  return buildStreamContentChunk(id, created, model, '<think>\n');
}

export function buildStreamProgressChunk(
  id: string,
  created: number,
  model: string,
  stage: StreamProgressStage,
  language: StreamProgressLanguage
): string {
  return buildStreamContentChunk(id, created, model, `${streamProgressMessages[language][stage]}\n`);
}

export function buildStreamThinkCloseChunk(id: string, created: number, model: string): string {
  return buildStreamContentChunk(id, created, model, '</think>\n');
}

export function buildStreamStopChunk(id: string, created: number, model: string): string {
  return serializeChunk({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  });
}

export function buildStreamDoneChunk(): string {
  return 'data: [DONE]\n\n';
}

export function buildStreamResponse(id: string, created: number, model: string, imageUrl: string): string {
  return [
    buildStreamRoleChunk(id, created, model),
    buildStreamContentChunk(id, created, model, `![generated image](${imageUrl})`),
    buildStreamStopChunk(id, created, model),
    buildStreamDoneChunk()
  ].join('');
}

export function buildStreamError(message: string): string {
  return `event: error\ndata: ${JSON.stringify({ error: { message } })}\n\n${buildStreamDoneChunk()}`;
}
