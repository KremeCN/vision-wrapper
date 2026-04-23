import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lookup as lookupMime } from 'mime-types';
import { createFileId } from '../utils/id.js';
import { createPromptDigest, type FileMetadataStore } from './fileMetadataStore.js';

export type StoredImage = {
  fileId: string;
  filePath: string;
  publicUrl: string;
  mimeType: string;
};

type LocalFileStoreOptions = {
  rootDir: string;
  publicBaseUrl: string;
  metadataStore: FileMetadataStore;
};

export class LocalFileStore {
  constructor(private readonly options: LocalFileStoreOptions) {}

  async saveBase64Image(base64Payload: string, extension = 'png', context?: { model: string; prompt: string }): Promise<StoredImage> {
    const buffer = Buffer.from(base64Payload, 'base64');
    return this.saveBuffer(buffer, extension, undefined, 'b64', context);
  }

  async saveRemoteImage(imageUrl: string, context?: { model: string; prompt: string }): Promise<StoredImage> {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download upstream image: ${response.status}`);
    }

    const mimeType = response.headers.get('content-type') ?? 'image/png';
    const extension = mimeType.split('/')[1] ?? 'png';
    const arrayBuffer = await response.arrayBuffer();
    return this.saveBuffer(Buffer.from(arrayBuffer), extension, mimeType, 'remote_url', context);
  }

  async readFileById(fileId: string): Promise<{ filePath: string; buffer: Buffer; mimeType: string }> {
    const safeFileId = normalizeFileId(fileId);
    const filePath = path.join(this.options.rootDir, safeFileId);
    const buffer = await readFile(filePath);
    const mimeType = lookupMime(filePath) || 'application/octet-stream';
    return { filePath, buffer, mimeType };
  }

  private async saveBuffer(
    buffer: Buffer,
    extension: string,
    explicitMimeType?: string,
    upstreamSource: 'b64' | 'remote_url' = 'b64',
    context?: { model: string; prompt: string }
  ): Promise<StoredImage> {
    const now = new Date();
    const relativeDir = path.join(
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0')
    );
    const filename = `${createFileId()}.${sanitizeExtension(extension)}`;
    const relativeFilePath = path.join(relativeDir, filename);
    const fullDir = path.join(this.options.rootDir, relativeDir);
    const fullPath = path.join(this.options.rootDir, relativeFilePath);

    await mkdir(fullDir, { recursive: true });
    await writeFile(fullPath, buffer);

    const normalizedId = relativeFilePath.replaceAll('\\', '/');
    const mimeType = explicitMimeType ?? (lookupMime(fullPath) || 'application/octet-stream').toString();

    if (context) {
      await this.options.metadataStore.write({
        fileId: normalizedId,
        model: context.model,
        createdAt: now.toISOString(),
        mimeType,
        sizeBytes: buffer.byteLength,
        upstreamSource,
        promptDigest: createPromptDigest(context.prompt)
      });
    }

    return {
      fileId: normalizedId,
      filePath: fullPath,
      publicUrl: `${this.options.publicBaseUrl}/files/${encodeURIComponent(normalizedId)}`,
      mimeType
    };
  }
}

function sanitizeExtension(extension: string): string {
  return extension.replace(/[^a-zA-Z0-9]/g, '') || 'png';
}

function normalizeFileId(fileId: string): string {
  const decoded = decodeURIComponent(fileId);
  if (decoded.includes('..') || path.isAbsolute(decoded)) {
    throw new Error('Invalid file id');
  }
  return decoded.replaceAll('/', path.sep);
}
