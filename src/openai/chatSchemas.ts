import { z } from 'zod';

const chatMessageContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional()
}).passthrough();

const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'developer', 'tool']),
  content: z.union([
    z.string(),
    z.array(chatMessageContentPartSchema)
  ])
}).passthrough();

export const chatCompletionsRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  background: z.string().optional(),
  n: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  user: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  response_format: z.record(z.string(), z.unknown()).optional(),
  modalities: z.array(z.string()).optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  parallel_tool_calls: z.boolean().optional()
}).passthrough();

export type ChatMessageContentPart = z.infer<typeof chatMessageContentPartSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatCompletionsRequest = z.infer<typeof chatCompletionsRequestSchema>;

export type ChatCompletionResponse = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};
