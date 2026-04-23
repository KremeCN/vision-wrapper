import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as dns from 'node:dns';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSafeRequestForTests, setSafeRequestForTests } from '../security/safeFetch.js';
import { FileMetadataStore, createPromptDigest } from '../storage/fileMetadataStore.js';
import { LocalFileStore } from '../storage/localFileStore.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  resetSafeRequestForTests();
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
      metadataStore,
      remoteImageUrlPolicy: 'https_only'
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
      metadataStore,
      remoteImageUrlPolicy: 'http_and_https'
    });

    await expect(store.saveRemoteImage('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      'Upstream returned an unsafe image URL'
    );
  });

  it('rejects localhost upstream remote image urls', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-localhost-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'http_and_https'
    });

    await expect(store.saveRemoteImage('http://localhost/image.png')).rejects.toThrow('Upstream returned an unsafe image URL');
  });

  it('rejects ipv6 loopback upstream remote image urls', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-ipv6-loopback-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'http_and_https'
    });

    await expect(store.saveRemoteImage('http://[::1]/image.png')).rejects.toThrow('Upstream returned an unsafe image URL');
  });

  it('rejects ipv6 ula upstream remote image urls', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-ipv6-ula-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'http_and_https'
    });

    await expect(store.saveRemoteImage('http://[fc00::1]/image.png')).rejects.toThrow('Upstream returned an unsafe image URL');
  });

  it('rejects ipv6 link-local upstream remote image urls', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-ipv6-linklocal-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'http_and_https'
    });

    await expect(store.saveRemoteImage('http://[fe80::1]/image.png')).rejects.toThrow('Upstream returned an unsafe image URL');
  });

  it('rejects unspecified upstream remote image urls', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-unspecified-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'http_and_https'
    });

    await expect(store.saveRemoteImage('http://0.0.0.0/image.png')).rejects.toThrow('Upstream returned an unsafe image URL');
  });

  it('rejects non-http upstream remote image urls', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-non-http-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'http_and_https'
    });

    await expect(store.saveRemoteImage('file:///tmp/image.png')).rejects.toThrow('Upstream returned an unsafe image URL');
    await expect(store.saveRemoteImage('ftp://example.com/image.png')).rejects.toThrow('Upstream returned an unsafe image URL');
    await expect(store.saveRemoteImage('data:text/plain,hello')).rejects.toThrow('Upstream returned an unsafe image URL');
  });
  it('rejects http upstream remote image urls when policy is https only', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-http-policy-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'https_only'
    });

    await expect(store.saveRemoteImage('http://cdn.example.com/image.png')).rejects.toThrow(
      'Upstream returned a non-public or non-https image URL'
    );
  });

  it('rejects upstream remote image urls when policy is disabled', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-disabled-policy-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'disabled'
    });

    await expect(store.saveRemoteImage('https://cdn.example.com/image.png')).rejects.toThrow(
      'Upstream returned a remote image URL but remote image downloads are disabled'
    );
  });

  it('rejects hostnames whose dns answers include private addresses', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-dns-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'https_only'
    });

    const lookupSpy = vi.spyOn(dns.promises, 'lookup') as unknown as { mockImplementation(fn: () => Promise<dns.LookupAddress[]>): unknown };
    lookupSpy.mockImplementation(async () => [{ address: '10.0.0.7', family: 4 }]);

    await expect(store.saveRemoteImage('https://cdn.example.com/image.png')).rejects.toThrow(
      'Upstream returned a non-public or non-https image URL'
    );
  });

  it('rejects non-image content-type from upstream remote image urls', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-non-image-content-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'https_only'
    });

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

    await expect(store.saveRemoteImage('https://cdn.example.com/image.png')).rejects.toThrow(
      'Upstream image URL must return an image content-type (received text/html)'
    );
  });

  it('downloads allowed upstream remote image urls', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vision-wrapper-remote-'));
    tempDirs.push(rootDir);

    const metadataStore = new FileMetadataStore({ rootDir });
    const store = new LocalFileStore({
      rootDir,
      publicBaseUrl: 'https://example.com',
      metadataStore,
      remoteImageUrlPolicy: 'https_only'
    });

    const lookupSpy = vi.spyOn(dns.promises, 'lookup') as unknown as { mockImplementation(fn: () => Promise<dns.LookupAddress[]>): unknown };
    lookupSpy.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
    const requestMock = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body: {
        arrayBuffer: async () => Buffer.from('remote-image')
      }
    });
    setSafeRequestForTests(requestMock as never);

    const stored = await store.saveRemoteImage('https://cdn.example.com/image.png', {
      model: 'gpt-image-2',
      prompt: 'draw a cat'
    });

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
      metadataStore,
      remoteImageUrlPolicy: 'https_only'
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

