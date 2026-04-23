import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.js';
import { FileMetadataStore } from '../storage/fileMetadataStore.js';

const config = loadConfig();
const metadataStore = new FileMetadataStore({ rootDir: config.imageStorageDir });
const removed = await metadataStore.cleanupExpired(config.fileTtlHours);

const currentDir = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] === join(currentDir, 'cleanupExpiredFiles.js')) {
  console.log(`Removed ${removed} expired files.`);
}
