import { describe, expect, it, vi } from 'vitest';
import * as dns from 'node:dns';
import { buildChatResponse } from '../domain/buildChatResponse.js';
import { buildImageRequest } from '../domain/buildImageRequest.js';
import {
  buildStreamProgressChunk,
  buildStreamResponse,
  buildStreamThinkCloseChunk,
  buildStreamThinkOpenChunk
} from '../domain/buildStreamResponse.js';
import { detectImageIntent } from '../domain/detectImageIntent.js';
import { extractPrompt } from '../domain/extractPrompt.js';
import { extractImageInput } from '../domain/extractImageInput.js';
import { buildImageEditsForm } from '../domain/buildImageEditsRequest.js';
import { resetSafeRequestForTests, setSafeRequestForTests } from '../security/safeFetch.js';

describe('detectImageIntent', () => {
  it('matches configured image models', () => {
    const config = { imageModelAliases: new Set(['gpt-image-2']) } as const;
    expect(detectImageIntent('gpt-image-2', config as never)).toBe(true);
    expect(detectImageIntent('gpt-4.1', config as never)).toBe(false);
  });
});

describe('extractPrompt', () => {
  it('uses the last user string content', () => {
    expect(extractPrompt({
      model: 'gpt-image-2',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ignore' },
        { role: 'user', content: 'second' }
      ]
    }, 100)).toBe('second');
  });

  it('joins text content parts', () => {
    expect(extractPrompt({
      model: 'gpt-image-2',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'draw' },
            { type: 'text', text: 'a cat' }
          ]
        }
      ]
    }, 100)).toBe('draw\na cat');
  });
});

describe('buildImageRequest', () => {
  it('maps supported image fields', () => {
    expect(buildImageRequest({
      model: 'gpt-image-2',
      messages: [],
      size: '1024x1024',
      quality: 'high',
      background: 'transparent'
    }, 'prompt')).toEqual({
      model: 'gpt-image-2',
      prompt: 'prompt',
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      n: 1
    });
  });
});

describe('buildImageEditsForm', () => {
  it('maps supported image edit fields into multipart form data', async () => {
    const lookupSpy = vi.spyOn(dns.promises, 'lookup') as unknown as { mockImplementation(fn: () => Promise<dns.LookupAddress[]>): unknown };
    lookupSpy.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
    const requestMock = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body: {
        arrayBuffer: async () => Buffer.from('image-bytes')
      }
    });
    setSafeRequestForTests(requestMock as never);

    const { formData } = await buildImageEditsForm({
      model: 'gpt-image-2',
      messages: [],
      size: '1024x1024',
      quality: 'high',
      background: 'transparent'
    }, 'prompt', 'https://example.com/input.png', 'https_only');

    expect(formData.get('model')).toBe('gpt-image-2');
    expect(formData.get('prompt')).toBe('prompt');
    expect(formData.get('size')).toBe('1024x1024');
    expect(formData.get('quality')).toBe('high');
    expect(formData.get('background')).toBe('transparent');
    expect(formData.get('n')).toBe('1');
    expect(formData.get('image')).toBeInstanceOf(File);
    resetSafeRequestForTests();
  });

  it('rejects localhost image input urls', async () => {
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'http://127.0.0.1/input.png', 'http_and_https')).rejects.toThrow('Image input URL must be a public http/https address');
  });

  it('rejects localhost hostname image input urls', async () => {
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'http://localhost/input.png', 'http_and_https')).rejects.toThrow('Image input URL must be a public http/https address');
  });

  it('rejects ipv6 loopback image input urls', async () => {
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'http://[::1]/input.png', 'http_and_https')).rejects.toThrow('Image input URL must be a public http/https address');
  });

  it('rejects ipv6 ula image input urls', async () => {
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'http://[fc00::1]/input.png', 'http_and_https')).rejects.toThrow('Image input URL must be a public http/https address');
  });

  it('rejects ipv6 link-local image input urls', async () => {
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'http://[fe80::1]/input.png', 'http_and_https')).rejects.toThrow('Image input URL must be a public http/https address');
  });

  it('rejects unspecified ipv4 image input urls', async () => {
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'http://0.0.0.0/input.png', 'http_and_https')).rejects.toThrow('Image input URL must be a public http/https address');
  });

  it('rejects non-http image input urls', async () => {
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'file:///tmp/input.png', 'http_and_https')).rejects.toThrow('Image input URL must be a public http/https address');
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'ftp://example.com/input.png', 'http_and_https')).rejects.toThrow('Image input URL must be a public http/https address');
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'data:text/plain,hello', 'http_and_https')).rejects.toThrow('Image input URL must be a public http/https address');
  });

  it('rejects http image input urls when policy is https only', async () => {
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'http://example.com/input.png', 'https_only')).rejects.toThrow('Image input URL must be a public https address');
  });

  it('rejects all remote image input urls when policy is disabled', async () => {
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'https://example.com/input.png', 'disabled')).rejects.toThrow('Remote image URLs are disabled');
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    const lookupSpy = vi.spyOn(dns.promises, 'lookup') as unknown as { mockImplementation(fn: () => Promise<dns.LookupAddress[]>): unknown };
    lookupSpy.mockImplementation(async () => [{ address: '127.0.0.1', family: 4 }]);
    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'https://evil.example/input.png', 'https_only')).rejects.toThrow('Image input URL must be a public https address');
  });

  it('rejects non-image content-type from image input urls', async () => {
    const lookupSpy = vi.spyOn(dns.promises, 'lookup') as unknown as { mockImplementation(fn: () => Promise<dns.LookupAddress[]>): unknown };
    lookupSpy.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
    const requestMock = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: {
        arrayBuffer: async () => Buffer.from('<html></html>')
      }
    });
    setSafeRequestForTests(requestMock as never);

    await expect(buildImageEditsForm({
      model: 'gpt-image-2',
      messages: []
    }, 'prompt', 'https://example.com/input.png', 'https_only')).rejects.toThrow(
      'Image input URL must return an image content-type (received text/html)'
    );
    resetSafeRequestForTests();
  });
});

describe('extractImageInput', () => {
  it('extracts image_url content part', () => {
    expect(extractImageInput({
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
    })?.imageUrl).toBe('https://example.com/input.png');
  });
});

describe('buildChatResponse', () => {
  it('returns markdown image content', () => {
    const response = buildChatResponse('gpt-image-2', 'https://example.com/file.png');
    expect(response.object).toBe('chat.completion');
    expect(response.choices[0]?.message.content).toContain('https://example.com/file.png');
  });
});

describe('buildStreamResponse', () => {
  it('returns SSE data and done marker', () => {
    const stream = buildStreamResponse('id', 1, 'gpt-image-2', 'https://example.com/file.png');
    expect(stream).toContain('chat.completion.chunk');
    expect(stream).toContain('https://example.com/file.png');
    expect(stream).toContain('[DONE]');
  });

  it('builds localized progress chunks', () => {
    expect(buildStreamProgressChunk('id', 1, 'gpt-image-2', 'accepted', 'en')).toContain('Processing your image request.');
    expect(buildStreamProgressChunk('id', 1, 'gpt-image-2', 'accepted', 'zh')).toContain('正在处理你的图片请求。');
  });

  it('builds think wrapper chunks', () => {
    expect(buildStreamThinkOpenChunk('id', 1, 'gpt-image-2')).toContain('<think>');
    expect(buildStreamThinkCloseChunk('id', 1, 'gpt-image-2')).toContain('</think>');
  });
});

