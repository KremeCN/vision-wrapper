import { randomUUID } from 'node:crypto';

export function createRequestId(): string {
  return `req_${randomUUID().replaceAll('-', '')}`;
}
