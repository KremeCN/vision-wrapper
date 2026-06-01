import { z } from 'zod';

const remoteImageUrlPolicySchema = z.enum(['https_only', 'http_and_https', 'disabled']);
const booleanStringSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().url(),
  UPSTREAM_BASE_URL: z.string().url(),
  UPSTREAM_API_KEY: z.string().min(1),
  PROXY_API_KEYS: z.string().min(1),
  IMAGE_MODEL_ALIASES: z.string().default('gpt-image-2'),
  IMAGE_MODEL_ROUTES_JSON: z.string().optional(),
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
  NATIVE_IMAGES_CONVERT_INPUT_TO_PNG: booleanStringSchema.default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

export type RemoteImageUrlPolicy = z.infer<typeof remoteImageUrlPolicySchema>;

export type ImageModelRoute = {
  model: string;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  upstreamModel: string;
};

export type AppConfig = {
  port: number;
  host: string;
  publicBaseUrl: string;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  proxyApiKeys: Set<string>;
  imageModelAliases: Set<string>;
  imageModelRoutes: Map<string, ImageModelRoute>;
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
  nativeImagesConvertInputToPng: boolean;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
};

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

type RawImageModelRoute = {
  model?: unknown;
  upstreamBaseUrl?: unknown;
  upstreamApiKey?: unknown;
  upstreamModel?: unknown;
};

function normalizeUpstreamBaseUrl(value: string, source: string): string {
  if (!value.endsWith('/v1')) {
    throw new Error(`${source} must end with /v1`);
  }
  return value.replace(/\/$/, '');
}

function buildLegacyImageModelRoutes(parsed: z.infer<typeof envSchema>, imageModelAliases: Set<string>): Map<string, ImageModelRoute> {
  const upstreamBaseUrl = normalizeUpstreamBaseUrl(parsed.UPSTREAM_BASE_URL, 'UPSTREAM_BASE_URL');
  return new Map(Array.from(imageModelAliases).map((model) => [model, {
    model,
    upstreamBaseUrl,
    upstreamApiKey: parsed.UPSTREAM_API_KEY,
    upstreamModel: model
  }]));
}

function parseImageModelRoutesJson(value: string): Map<string, ImageModelRoute> {
  let payload: unknown;
  try {
    payload = JSON.parse(value) as unknown;
  } catch {
    throw new Error('IMAGE_MODEL_ROUTES_JSON must be valid JSON');
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('IMAGE_MODEL_ROUTES_JSON must be a non-empty JSON array');
  }

  const routes = new Map<string, ImageModelRoute>();
  for (const item of payload as RawImageModelRoute[]) {
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    const upstreamBaseUrl = typeof item.upstreamBaseUrl === 'string' ? item.upstreamBaseUrl.trim() : '';
    const upstreamApiKey = typeof item.upstreamApiKey === 'string' ? item.upstreamApiKey.trim() : '';
    const upstreamModel = typeof item.upstreamModel === 'string' && item.upstreamModel.trim()
      ? item.upstreamModel.trim()
      : model;

    if (!model) {
      throw new Error('Each IMAGE_MODEL_ROUTES_JSON item must include a non-empty model');
    }
    if (!upstreamBaseUrl) {
      throw new Error(`IMAGE_MODEL_ROUTES_JSON route '${model}' must include upstreamBaseUrl`);
    }
    if (!upstreamApiKey) {
      throw new Error(`IMAGE_MODEL_ROUTES_JSON route '${model}' must include upstreamApiKey`);
    }
    if (routes.has(model)) {
      throw new Error(`IMAGE_MODEL_ROUTES_JSON includes duplicate model '${model}'`);
    }

    routes.set(model, {
      model,
      upstreamBaseUrl: normalizeUpstreamBaseUrl(upstreamBaseUrl, `IMAGE_MODEL_ROUTES_JSON route '${model}' upstreamBaseUrl`),
      upstreamApiKey,
      upstreamModel
    });
  }

  return routes;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const proxyApiKeys = new Set(splitCsv(parsed.PROXY_API_KEYS));
  const legacyImageModelAliases = new Set(splitCsv(parsed.IMAGE_MODEL_ALIASES));
  const imageModelRoutes = parsed.IMAGE_MODEL_ROUTES_JSON
    ? parseImageModelRoutesJson(parsed.IMAGE_MODEL_ROUTES_JSON)
    : buildLegacyImageModelRoutes(parsed, legacyImageModelAliases);
  const imageModelAliases = new Set(imageModelRoutes.keys());

  if (proxyApiKeys.size === 0) {
    throw new Error('PROXY_API_KEYS must include at least one token');
  }

  if (!parsed.IMAGE_MODEL_ROUTES_JSON && legacyImageModelAliases.size === 0) {
    throw new Error('IMAGE_MODEL_ALIASES must include at least one model');
  }

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    publicBaseUrl: parsed.PUBLIC_BASE_URL.replace(/\/$/, ''),
    upstreamBaseUrl: normalizeUpstreamBaseUrl(parsed.UPSTREAM_BASE_URL, 'UPSTREAM_BASE_URL'),
    upstreamApiKey: parsed.UPSTREAM_API_KEY,
    proxyApiKeys,
    imageModelAliases,
    imageModelRoutes,
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
    nativeImagesConvertInputToPng: parsed.NATIVE_IMAGES_CONVERT_INPUT_TO_PNG,
    logLevel: parsed.LOG_LEVEL
  };
}
