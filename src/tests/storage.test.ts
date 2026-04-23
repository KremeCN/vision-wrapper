import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as dns from 'node:dns';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileMetadataStore, createPromptDigest } from '../storage/fileMetadataStore.js';
import { LocalFileStore } from '../storage/localFileStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('LocalFileStore', () => {
  it('writes and reads an image by id', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore
    });

    const stored = await store.saveBase64Image(Buffer.from('hello').toString('base64'), 'png', {
      model: 'gpt-image-2',
      prompt: 'draw a cat'
    });
    const file = await store.readFileById(stored.fileId);
    const metadata = await metadataStore.read(stored.fileId);

    expect(stored.publicUrl).toContain('/files/');
    expect(file.buffer.toString()).toBe('hello');
    expect(file.mimeType).toBe('image/png');
    expect(metadata.model).toBe('gpt-image-2');
    expect(metadata.promptDigest).toBe(createPromptDigest('draw a cat'));
  });

  it('rejects unsafe upstream remote image urls', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-ssrf-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore
    });

    await expect(store.saveRemoteImage('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      'Upstream returned an unsafe image URL'
    );
  });

  it('rejects hostnames whose dns answers include private addresses', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-dns-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore
    });

    const lookupSpy = vi.spyOn(dns.promises, 'lookup') as unknown as { mockImplementation(fn: () => Promise<dns.LookupAddress[]>): unknown };
    lookupSpy.mockImplementation(async () => [{ address: '10.0.0.7', family: 4 }]);

    await expect(store.saveRemoteImage('https://cdn.example.com/image.png')).rejects.toThrow(
      'Upstream returned an unsafe image URL'
    );
  });

  it('downloads allowed upstream remote image urls', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-remote-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore
    });

    const lookupSpy = vi.spyOn(dns.promises, 'lookup') as unknown as { mockImplementation(fn: () => Promise<dns.LookupAddress[]>): unknown };
    lookupSpy.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => Buffer.from('remote-image')
    });
    vi.stubGlobal('fetch', fetchMock);

    const stored = await store.saveRemoteImage('https://cdn.example.com/image.png', {
      model: 'gpt-image-2',
      prompt: 'draw a cat'
    });

    expect(fetchMock).toHaveBeenCalledWith(new URL('https://cdn.example.com/image.png'));
    const file = await store.readFileById(stored.fileId);
    expect(file.buffer.toString()).toBe('remote-image');
  });

  it('cleans up expired metadata and files', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-cleanup-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore
    });

    const stored = await store.saveBase64Image(Buffer.from('hello').toString('base64'), 'png', {
      model: 'gpt-image-2',
      prompt: 'draw a cat'
    });

    const metadataPath = metadataStore.getMetadataPath(stored.fileId);
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await readFile(metadataPath, 'utf8');
    await import('node:fs/promises').then(({ utimes }) => utimes(metadataPath, oldTime, oldTime));

    const removed = await metadataStore.cleanupExpired(1);
    expect(removed).toBe(1);
  });
});

