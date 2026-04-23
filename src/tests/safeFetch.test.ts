import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as dns from 'node:dns';
import { assertSafeClientImageUrl } from '../security/safeExternalUrl.js';
import { resetSafeRequestForTests, safeDownload, setSafeRequestForTests } from '../security/safeFetch.js';

describe('safeDownload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSafeRequestForTests();
  });

  it('pins the approved IP while preserving the original host header', async () => {
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

    const resolved = await assertSafeClientImageUrl('https://example.com/input.png', { policy: 'https_only' });
    const response = await safeDownload(resolved);

    expect(response.status).toBe(200);
    expect(requestMock).toHaveBeenCalledWith(resolved.url, expect.objectContaining({
      method: 'GET',
      headers: { host: 'example.com' }
    }));
  });
});
