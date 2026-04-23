import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileMetadataStore, createPromptDigest } from '../storage/fileMetadataStore.js';
import { LocalFileStore } from '../storage/localFileStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
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
