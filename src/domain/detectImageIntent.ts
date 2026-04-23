import type { AppConfig } from '../config.js';

export function detectImageIntent(model: string, config: AppConfig): boolean {
  return config.imageModelAliases.has(model.trim());
}
