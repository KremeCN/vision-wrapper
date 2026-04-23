import { z } from 'zod';

const remoteImageUrlPolicySchema = z.enum(['https_only', 'http_and_https', 'disabled']);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().url(),
  UPSTREAM_BASE_URL: z.string().url(),
  UPSTREAM_API_KEY: z.string().min(1),
  PROXY_API_KEYS: z.string().min(1),
  IMAGE_MODEL_ALIASES: z.string().default('gpt-image-1'),
  IMAGE_STORAGE_DIR: z.string().min(1).default('data/images'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  MAX_PROMPT_CHARS: z.coerce.number().int().positive().default(4000),
  CORS_ALLOW_ORIGIN: z.string().default('*'),
  FILE_TTL_HOURS: z.coerce.number().int().positive().default(168),
  STREAM_PROGRESS_LANGUAGE: z.enum(['en', 'zh']).default('en'),
  REMOTE_IMAGE_URL_POLICY: remoteImageUrlPolicySchema.default('https_only'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

export type RemoteImageUrlPolicy = z.infer<typeof remoteImageUrlPolicySchema>;

export type AppConfig = {
  port: number;
  host: string;
  publicBaseUrl: string;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  proxyApiKeys: Set<string>;
  imageModelAliases: Set<string>;
  imageStorageDir: string;
  requestTimeoutMs: number;
  bodyLimitBytes: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  maxPromptChars: number;
  corsAllowOrigin: string;
  fileTtlHours: number;
  streamProgressLanguage: 'en' | 'zh';
  remoteImageUrlPolicy: RemoteImageUrlPolicy;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
};

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const proxyApiKeys = new Set(splitCsv(parsed.PROXY_API_KEYS));
  const imageModelAliases = new Set(splitCsv(parsed.IMAGE_MODEL_ALIASES));

  if (proxyApiKeys.size === 0) {
    throw new Error('PROXY_API_KEYS must include at least one token');
  }

  if (imageModelAliases.size === 0) {
    throw new Error('IMAGE_MODEL_ALIASES must include at least one model');
  }

  if (imageModelAliases.size !== 1) {
    throw new Error('IMAGE_MODEL_ALIASES must include exactly one model');
  }

  if (!parsed.UPSTREAM_BASE_URL.endsWith('/v1')) {
    throw new Error('UPSTREAM_BASE_URL must end with /v1');
  }

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    publicBaseUrl: parsed.PUBLIC_BASE_URL.replace(/\/$/, ''),
    upstreamBaseUrl: parsed.UPSTREAM_BASE_URL.replace(/\/$/, ''),
    upstreamApiKey: parsed.UPSTREAM_API_KEY,
    proxyApiKeys,
    imageModelAliases,
    imageStorageDir: parsed.IMAGE_STORAGE_DIR,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    bodyLimitBytes: parsed.BODY_LIMIT_BYTES,
    rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: parsed.RATE_LIMIT_MAX,
    maxPromptChars: parsed.MAX_PROMPT_CHARS,
    corsAllowOrigin: parsed.CORS_ALLOW_ORIGIN,
    fileTtlHours: parsed.FILE_TTL_HOURS,
    streamProgressLanguage: parsed.STREAM_PROGRESS_LANGUAGE,
    remoteImageUrlPolicy: parsed.REMOTE_IMAGE_URL_POLICY,
    logLevel: parsed.LOG_LEVEL
  };
}
