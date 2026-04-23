import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type StoredFileMetadata = {
  fileId: string;
  model: string;
  createdAt: string;
  mimeType: string;
  sizeBytes: number;
  upstreamSource: 'b64' | 'remote_url';
  promptDigest: string;
};

type FileMetadataStoreOptions = {
  rootDir: string;
};

export class FileMetadataStore {
  constructor(private readonly options: FileMetadataStoreOptions) {}

  async write(metadata: StoredFileMetadata): Promise<void> {
    const metadataPath = this.getMetadataPath(metadata.fileId);
    await mkdir(path.dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  }

  async read(fileId: string): Promise<StoredFileMetadata> {
    const metadataPath = this.getMetadataPath(fileId);
    const content = await readFile(metadataPath, 'utf8');
    return JSON.parse(content) as StoredFileMetadata;
  }

  async cleanupExpired(ttlHours: number): Promise<number> {
    const metadataRoot = path.join(this.options.rootDir, '.meta');
    const now = Date.now();
    let removed = 0;

    for (const metadataFile of await collectJsonFiles(metadataRoot)) {
      const fileStat = await stat(metadataFile);
      const ageMs = now - fileStat.mtimeMs;
      if (ageMs <= ttlHours * 60 * 60 * 1000) {
        continue;
      }

      const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as StoredFileMetadata;
      const imagePath = path.join(this.options.rootDir, metadata.fileId.replaceAll('/', path.sep));
      await rm(imagePath, { force: true });
      await rm(metadataFile, { force: true });
      removed += 1;
    }

    return removed;
  }

  getMetadataPath(fileId: string): string {
    return path.join(this.options.rootDir, '.meta', `${fileId.replaceAll('/', path.sep)}.json`);
  }
}

export function createPromptDigest(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

async function collectJsonFiles(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return collectJsonFiles(fullPath);
      }
      return fullPath.endsWith('.json') ? [fullPath] : [];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}
