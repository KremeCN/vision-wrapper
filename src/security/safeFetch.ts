import { Agent, request } from 'undici';
import { UpstreamError } from '../http/errors.js';
import type { SafeResolvedUrl } from './safeExternalUrl.js';

export type SafeRequest = typeof request;

let requestImpl: SafeRequest = request;

export function setSafeRequestForTests(next: SafeRequest): void {
  requestImpl = next;
}

export function resetSafeRequestForTests(): void {
  requestImpl = request;
}

export async function safeDownload(resolved: SafeResolvedUrl): Promise<Response> {
  const { url, address } = resolved;
  const dispatcher = new Agent({
    connect: {
      servername: url.hostname,
      ...(url.hostname !== address ? { host: address } : {})
    }
  });

  try {
    const response = await requestImpl(url, {
      dispatcher,
      method: 'GET',
      headers: {
        host: url.host
      }
    });

    const body = await response.body.arrayBuffer();
    return new Response(body, {
      status: response.statusCode,
      headers: response.headers as HeadersInit
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UpstreamError(504, 'Upstream image generation timed out', 'upstream_timeout');
    }
    throw error;
  } finally {
    await dispatcher.close();
  }
}
