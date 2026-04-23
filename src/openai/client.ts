import { UpstreamError } from '../http/errors.js';
import type {
  ImagesGenerationRequest,
  ImagesGenerationResponse
} from './imageSchemas.js';

type SupportedImageOperation = 'generations' | 'edits';

type ForwardedImagesResponse = {
  statusCode: number;
  contentType: string;
  body: unknown;
};

type ForwardedImagesRequest = {
  contentType: string | undefined;
  body: unknown;
};

type BuiltImageEditsForm = {
  formData: FormData;
};

export class OpenAiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number
  ) {}

  async generateImage(request: ImagesGenerationRequest): Promise<ImagesGenerationResponse> {
    const response = await this.requestImages('generations', request, 'application/json');
    return response.body as ImagesGenerationResponse;
  }

  async editImage(request: BuiltImageEditsForm): Promise<ImagesGenerationResponse> {
    const response = await this.requestImages('edits', request.formData, undefined);
    return response.body as ImagesGenerationResponse;
  }

  async forwardImagesRequest(
    operation: SupportedImageOperation,
    request: ForwardedImagesRequest
  ): Promise<ForwardedImagesResponse> {
    return this.requestImages(operation, request.body, request.contentType);
  }

  private async requestImages(
    operation: SupportedImageOperation,
    body: unknown,
    contentType: string | undefined
  ): Promise<ForwardedImagesResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/images/${operation}`, {
        method: 'POST',
        headers: {
          ...buildContentTypeHeader(body, contentType),
          authorization: `Bearer ${this.apiKey}`
        },
        body: toRequestBody(body, contentType),
        signal: controller.signal
      });

      const parsedBody = await parseResponseBody(response);
      if (!response.ok) {
        const errorBody = toErrorBody(parsedBody, response.status);
        throw new UpstreamError(mapStatusCode(response.status), errorBody.message, errorBody.code);
      }

      return {
        statusCode: response.status,
        contentType: response.headers.get('content-type') ?? 'application/json; charset=utf-8',
        body: parsedBody
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new UpstreamError(504, 'Upstream image generation timed out', 'upstream_timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mapStatusCode(statusCode: number): number {
  if (statusCode >= 500) {
    return 502;
  }
  if (statusCode === 401 || statusCode === 403) {
    return 502;
  }
  return 400;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return await response.json();
  }

  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function toErrorBody(payload: unknown, status: number): { message: string; code: string } {
  const maybeError = typeof payload === 'object' && payload !== null && 'error' in payload
    ? (payload as { error?: { message?: string; code?: string } }).error
    : undefined;

  return {
    message: maybeError?.message ?? `Upstream image request failed (${status})`,
    code: maybeError?.code ?? 'upstream_error'
  };
}

function buildContentTypeHeader(body: unknown, contentType: string | undefined): Record<string, string> {
  if (body instanceof FormData) {
    return {};
  }

  return {
    'content-type': contentType ?? 'application/json'
  };
}

function toRequestBody(body: unknown, contentType: string | undefined): BodyInit {
  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }

  if (body instanceof FormData) {
    return body;
  }

  if (!body) {
    return '';
  }

  if (contentType?.toLowerCase().includes('application/json')) {
    return JSON.stringify(body);
  }

  return JSON.stringify(body);
}
