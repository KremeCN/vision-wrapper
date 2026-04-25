import sharp from 'sharp';
import { promises as dns } from 'node:dns';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSafeRequestForTests, setSafeRequestForTests } from '../../security/safeFetch.js';
import { buildApp } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { createPromptDigest } from '../../storage/fileMetadataStore.js';


function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function extractMultipartFilePart(body: Buffer, boundary: string): { headers: string; content: Buffer } {
  const startMarker = Buffer.from(`--${boundary}\r\n`, 'utf8');
  const nextMarker = Buffer.from(`\r\n--${boundary}`, 'utf8');
  let cursor = body.indexOf(startMarker);

  while (cursor !== -1) {
    const headerStart = cursor + startMarker.length;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), headerStart);
    if (headerEnd === -1) {
      break;
    }

    const headers = body.subarray(headerStart, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(nextMarker, contentStart);
    if (contentEnd === -1) {
      break;
    }

    if (headers.includes('name="image"')) {
      return {
        headers,
        content: body.subarray(contentStart, contentEnd)
      };
    }

    cursor = body.indexOf(startMarker, contentEnd + 2);
  }

  throw new Error('Multipart image part not found');
}

function isPngSignature(buffer: Buffer): boolean {
  return buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
}

describe('HTTP routes', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    resetSafeRequestForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createConfig(overrides: Partial<AppConfig> = {}): Promise<AppConfig> {
    const imageStorageDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-http-'));
    tempDirs.push(imageStorageDir);

    return {
      port: 3000,
      host: '127.0.0.1',
      publicBaseUrl: 'http://127.0.0.1:3000',
      upstreamBaseUrl: 'http://upstream.test/v1',
      upstreamApiKey: 'upstream-token',
      proxyApiKeys: new Set(['test-token']),
      imageModelAliases: new Set(['gpt-image-2']),
      imageStorageDir,
      requestTimeoutMs: 1000,
      bodyLimitBytes: 20 * 1024 * 1024,
      rateLimitWindowMs: 60000,
      rateLimitMax: 10,
      maxPromptChars: 4000,
      corsAllowOrigin: '*',
      fileTtlHours: 168,
      streamProgressLanguage: 'en',
      logLevel: 'silent',
      remoteImageUrlPolicy: 'https_only',
      nativeImagesConvertInputToPng: false,
      ...overrides
    };
  }

  it('returns configured models', async () => {
    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer test-token' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.json().data[0].id).toBe('gpt-image-2');
    await app.close();
  });

  it('returns OpenAI-style error for unknown model', async () => {
    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'GET',
      url: '/v1/models/unknown-model',
      headers: { authorization: 'Bearer test-token' }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        message: "Model 'unknown-model' not found",
        type: 'invalid_request_error',
        param: null,
        code: 'model_not_found'
      }
    });
    await app.close();
  });

  it('returns OpenAI-style auth error', async () => {
    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'GET',
      url: '/v1/models'
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.type).toBe('authentication_error');
    await app.close();
  });

  it('rejects unsupported tool fields', async () => {
    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        messages: [{ role: 'user', content: 'draw a cat' }],
        tools: [{ type: 'function' }]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('unsupported_tools');
    await app.close();
  });


  it('does not treat encoded file path prefix as public route', async () => {
    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'GET',
      url: '/%66iles/secret'
    });

    expect(response.statusCode).not.toBe(200);
    await app.close();
  });

  it('returns streaming progress text in English by default', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({
        data: [{ b64_json: Buffer.from('image-bytes').toString('base64') }]
      }),
      text: async () => ''
    }));

    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        stream: true,
        messages: [{ role: 'user', content: 'draw a cat' }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<think>');
    expect(response.body).toContain('· Processing your image request.');
    expect(response.body).toContain('✻ Generating the image with the upstream provider.');
    expect(response.body).toContain('✽ Saving the generated image and preparing a public URL.');
    expect(response.body).toContain('❋ Image is ready.');
    expect(response.body).toContain('</think>');
    expect(response.body).toContain('![generated image](');
    await app.close();
  });

  it('returns streaming progress text in Chinese when configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({
        data: [{ b64_json: Buffer.from('image-bytes').toString('base64') }]
      }),
      text: async () => ''
    }));

    const app = await buildApp(await createConfig({ streamProgressLanguage: 'zh' }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        stream: true,
        messages: [{ role: 'user', content: 'draw a cat' }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<think>');
    expect(response.body).toContain('· 正在处理你的图片请求。');
    expect(response.body).toContain('✻ 正在调用上游服务生成图片。');
    expect(response.body).toContain('✽ 正在保存生成的图片并准备公开链接。');
    expect(response.body).toContain('❋ 图片已准备完成。');
    expect(response.body).toContain('</think>');
    expect(response.body).toContain('![generated image](');
    await app.close();
  });

  it('emits heartbeat comments during long streamed requests and stops after completion', async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const fetchDeferred = createDeferred<{
      ok: true;
      status: number;
      headers: { get: () => string };
      json: () => Promise<{ data: Array<{ b64_json: string }> }>;
      text: () => Promise<string>;
    }>();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => fetchDeferred.promise));

    const app = await buildApp(await createConfig());
    const responsePromise = app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        stream: true,
        messages: [{ role: 'user', content: 'draw a cat' }]
      }
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15000);
    await Promise.resolve();

    let settled = false;
    void responsePromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const clearIntervalCallsBeforeCompletion = clearIntervalSpy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(15000);
    await Promise.resolve();
    fetchDeferred.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({
        data: [{ b64_json: Buffer.from('image-bytes').toString('base64') }]
      }),
      text: async () => ''
    });
    await Promise.resolve();

    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    const heartbeatCount = (response.body.match(/: keep-alive\n\n/g) ?? []).length;
    expect(heartbeatCount).toBeGreaterThanOrEqual(2);
    expect(response.body).toContain('[DONE]');
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(clearIntervalCallsBeforeCompletion);

    await app.close();
  }, 15000);


  it('emits a visible stream error and closes think on upstream timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new DOMException('The operation was aborted', 'AbortError');
    }));

    const app = await buildApp(await createConfig({ requestTimeoutMs: 5 }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        stream: true,
        messages: [{ role: 'user', content: 'draw a cat' }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<think>');
    expect(response.body).toContain('</think>');
    expect(response.body).toContain('Error: Upstream image generation timed out');
    expect(response.body).toContain('[DONE]');
    await app.close();
  });

  it('routes chat with image input to upstream multipart edits', async () => {
    const lookupSpy = vi.spyOn(dns, 'lookup') as unknown as { mockImplementation(fn: () => Promise<Array<{ address: string; family: number }>>): unknown };
    lookupSpy.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
    const requestMock = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body: {
        arrayBuffer: async () => Buffer.from('input-image')
      }
    });
    setSafeRequestForTests(requestMock as never);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ data: [{ b64_json: Buffer.from('image-bytes').toString('base64') }] }),
      text: async () => ''
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'edit this image' },
              { type: 'image_url', image_url: { url: 'https://example.com/input.png' } }
            ]
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(requestMock).toHaveBeenCalledTimes(1);
    const upstreamCall = fetchMock.mock.calls[0];
    expect(upstreamCall?.[0]).toContain('/images/edits');
    const upstreamOptions = upstreamCall?.[1] as RequestInit | undefined;
    expect(upstreamOptions?.headers).toEqual({ authorization: 'Bearer upstream-token' });
    expect(upstreamOptions?.body).toBeInstanceOf(FormData);
    const upstreamForm = upstreamOptions?.body as FormData;
    expect(upstreamForm.get('model')).toBe('gpt-image-2');
    expect(upstreamForm.get('prompt')).toBe('edit this image');
    expect(upstreamForm.get('image')).toBeInstanceOf(File);
    const body = response.json();
    expect(body.choices[0]?.message.content).toContain('/files/chat%2F');
    const chatUrl = body.choices[0]?.message.content.match(/\((https?:[^)]+)\)/)?.[1];
    expect(chatUrl).toBeTruthy();
    const encodedFileId = chatUrl?.match(/\/files\/([^?)]+)/)?.[1];
    expect(encodedFileId).toBeTruthy();
    const fileResponse = await app.inject({ method: 'GET', url: `/files/${encodedFileId}` });
    expect(fileResponse.statusCode).toBe(200);
    await app.close();
  });

  it('routes chat with inline data url image input to upstream multipart edits', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ data: [{ b64_json: Buffer.from('image-bytes').toString('base64') }] }),
      text: async () => ''
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(await createConfig({ remoteImageUrlPolicy: 'disabled' }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'edit this image' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }
            ]
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const upstreamCall = fetchMock.mock.calls[0];
    expect(upstreamCall?.[0]).toContain('/images/edits');
    const upstreamOptions = upstreamCall?.[1] as RequestInit | undefined;
    expect(upstreamOptions?.body).toBeInstanceOf(FormData);
    expect((upstreamOptions?.body as FormData).get('image')).toBeInstanceOf(File);
    await app.close();
  });

  it('rejects invalid inline data url image input at HTTP layer', async () => {
    const app = await buildApp(await createConfig({ remoteImageUrlPolicy: 'disabled' }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'edit this image' },
              { type: 'image_url', image_url: { url: 'data:image/png,hello' } }
            ]
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_image_input');
    await app.close();
  });


  it('rejects chat image input with unsafe remote url at HTTP layer', async () => {
    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'edit this image' },
              { type: 'image_url', image_url: { url: 'http://127.0.0.1/input.png' } }
            ]
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('unsafe_image_url');
    await app.close();
  });
  it('passes through /v1/images/generations to upstream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ created: 1, data: [{ b64_json: Buffer.from('generated-image').toString('base64') }] }),
      text: async () => ''
    }));

    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        prompt: 'draw a cat'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].url).toContain('/files/native_images%2F');
    const filePath = new URL(response.json().data[0].url).pathname;
    const fileResponse = await app.inject({ method: 'GET', url: filePath });
    expect(fileResponse.statusCode).toBe(200);
    await app.close();
  });

  it('passes through /v1/images/edits to upstream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ created: 1, data: [{ b64_json: Buffer.from('edited-image').toString('base64') }] }),
      text: async () => ''
    }));

    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        prompt: 'edit this image'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].url).toContain('/files/native_images%2F');
    await app.close();
  });


  it('passes through multipart /v1/images/edits to upstream', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ created: 1, data: [{ b64_json: Buffer.from('edited-multipart-image').toString('base64') }] }),
      text: async () => ''
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(await createConfig());
    const boundary = '----visionwrappertest';
    const multipart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      '',
      'gpt-image-2',
      `--${boundary}`,
      'Content-Disposition: form-data; name="prompt"',
      '',
      'edit this image',
      `--${boundary}--`,
      ''
    ].join('\r\n');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].url).toContain('/files/native_images%2F');
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall?.[1]?.body).toBeInstanceOf(Uint8Array);
    const upstreamBody = Buffer.from(fetchCall?.[1]?.body as Uint8Array).toString('utf8');
    expect(upstreamBody).toContain('name="model"');
    await app.close();
  });

  it('stores multipart /v1/images/edits prompt digest from the prompt field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ created: 1, data: [{ b64_json: Buffer.from('edited-multipart-image').toString('base64') }] }),
      text: async () => ''
    }));

    const config = await createConfig();
    const app = await buildApp(config);
    const boundary = '----visionwrapperpromptdigest';
    const multipartPrompt = 'edit multipart image prompt';
    const multipart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      '',
      'gpt-image-2',
      `--${boundary}`,
      'Content-Disposition: form-data; name="prompt"',
      '',
      multipartPrompt,
      `--${boundary}--`,
      ''
    ].join('\r\n');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart
    });

    expect(response.statusCode).toBe(200);
    const encodedFileId = response.json().data[0].url.match(/\/files\/([^?)]+)/)?.[1];
    expect(encodedFileId).toBeTruthy();
    const metadataPath = path.join(config.imageStorageDir, '.meta', `${decodeURIComponent(encodedFileId as string).replaceAll('/', path.sep)}.json`);
    const metadataContent = await (await import('node:fs/promises')).readFile(metadataPath, 'utf8');
    const metadata = JSON.parse(metadataContent) as { promptDigest: string };
    expect(metadata.promptDigest).toBe(createPromptDigest(multipartPrompt));
    await app.close();
  });

  it('rejects multipart /v1/images/edits when model field is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(await createConfig());
    const boundary = '----visionwrappermissingmodel';
    const multipart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="prompt"',
      '',
      'edit this image',
      `--${boundary}--`,
      ''
    ].join('\r\n');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_multipart_model');
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });


  it('rejects multipart /v1/images/edits when multipart body cannot be reliably parsed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(await createConfig());
    const boundary = '----visionwrapperlfonly';
    const multipart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      '',
      'other-model',
      `--${boundary}--`,
      ''
    ].join('\n');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_multipart_model');
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('converts non-png multipart image inputs to png when enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ created: 1, data: [{ b64_json: Buffer.from('edited-converted-image').toString('base64') }] }),
      text: async () => ''
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(await createConfig({ nativeImagesConvertInputToPng: true }));
    const boundary = '----visionwrapperconvertjpeg';
    const sourcePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');
    const jpegPayload = await sharp(sourcePng).jpeg().toBuffer();
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`, 'utf8'),
      jpegPayload,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--${boundary}--\r\n`, 'utf8')
    ]);


    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart
    });

    expect(response.statusCode).toBe(200);
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall?.[1]?.body).toBeInstanceOf(Uint8Array);
    const upstreamBody = Buffer.from(fetchCall?.[1]?.body as Uint8Array);
    const imagePart = extractMultipartFilePart(upstreamBody, boundary);
    expect(imagePart.headers.toLowerCase()).toContain('content-type: image/png');
    expect(imagePart.headers).toContain('filename="input.png"');
    expect(isPngSignature(imagePart.content)).toBe(true);
    await app.close();
  });

  it('leaves png multipart image inputs unchanged when enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ created: 1, data: [{ b64_json: Buffer.from('edited-png-image').toString('base64') }] }),
      text: async () => ''
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(await createConfig({ nativeImagesConvertInputToPng: true }));
    const boundary = '----visionwrapperpngnoop';
    const pngPayload = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n`, 'utf8'),
      pngPayload,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--${boundary}--\r\n`, 'utf8')
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart
    });

    expect(response.statusCode).toBe(200);
    const fetchCall = fetchMock.mock.calls[0];
    const upstreamBody = Buffer.from(fetchCall?.[1]?.body as Uint8Array);
    const imagePart = extractMultipartFilePart(upstreamBody, boundary);
    expect(imagePart.headers.toLowerCase()).toContain('content-type: image/png');
    expect(imagePart.headers).toContain('filename="input.png"');
    expect(imagePart.content.equals(pngPayload)).toBe(true);
    await app.close();
  });

  it('returns 400 for invalid multipart image input when png conversion is enabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(await createConfig({ nativeImagesConvertInputToPng: true }));
    const boundary = '----visionwrapperinvalidimage';
    const invalidPayload = Buffer.from('not-a-real-image', 'utf8');
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`, 'utf8'),
      invalidPayload,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--${boundary}--\r\n`, 'utf8')
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_image_input');
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('passes through non-png multipart image inputs unchanged when conversion is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ created: 1, data: [{ b64_json: Buffer.from('edited-jpeg-image').toString('base64') }] }),
      text: async () => ''
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(await createConfig({ nativeImagesConvertInputToPng: false }));
    const boundary = '----visionwrapperdisabledconvert';
    const jpegPayload = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAA==', 'base64');
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`, 'utf8'),
      jpegPayload,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--${boundary}--\r\n`, 'utf8')
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart
    });

    expect(response.statusCode).toBe(200);
    const fetchCall = fetchMock.mock.calls[0];
    const upstreamBody = Buffer.from(fetchCall?.[1]?.body as Uint8Array);
    const imagePart = extractMultipartFilePart(upstreamBody, boundary);
    expect(imagePart.headers).toContain('Content-Type: image/jpeg');
    expect(imagePart.headers).toContain('filename="input.jpg"');
    expect(imagePart.content.equals(jpegPayload)).toBe(true);
    await app.close();
  });

  it('passes through multipart /v1/images/edits with quoted boundary and binary file payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ created: 1, data: [{ b64_json: Buffer.from('edited-binary-image').toString('base64') }] }),
      text: async () => ''
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(await createConfig());
    const boundary = '----visionwrapperquoted';
    const binaryPayload = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x61, 0x62]);
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n`, 'utf8'),
      binaryPayload,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n--${boundary}--\r\n`, 'utf8')
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary="${boundary}"`
      },
      payload: multipart
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].url).toContain('/files/native_images%2F');
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall?.[1]?.body).toBeInstanceOf(Uint8Array);
    await app.close();
  });

  it('maps image route timeout failures to 504', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new DOMException('The operation was aborted', 'AbortError');
    }));

    const app = await buildApp(await createConfig({ requestTimeoutMs: 5 }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        prompt: 'draw a cat'
      }
    });

    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe('upstream_timeout');
    await app.close();
  });

  it('maps image route network failures to 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        prompt: 'draw a cat'
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('upstream_network_error');
    await app.close();
  });

  it('rejects unsupported image operation', async () => {
    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/variations',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'gpt-image-2',
        prompt: 'draw a cat'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('unsupported_operation');
    await app.close();
  });

  it('rejects non-exposed model alias on image endpoints', async () => {
    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      payload: {
        model: 'other-model',
        prompt: 'draw a cat'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('unsupported_model');
    await app.close();
  });

  it('answers preflight requests', async () => {
    const app = await buildApp(await createConfig());
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/chat/completions'
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    await app.close();
  });
});
