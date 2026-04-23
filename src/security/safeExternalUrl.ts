import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { BadRequestError, UpstreamError } from '../http/errors.js';

const FORBIDDEN_HOSTNAMES = new Set(['localhost']);

export async function assertSafeClientImageUrl(rawUrl: string): Promise<URL> {
  return assertSafeExternalUrl(rawUrl, () => new BadRequestError('Image input URL must be a public http/https address', 'unsafe_image_url', 'messages'));
}

export async function assertSafeUpstreamImageUrl(rawUrl: string): Promise<URL> {
  return assertSafeExternalUrl(rawUrl, () => new UpstreamError(502, 'Upstream returned an unsafe image URL', 'unsafe_upstream_image_url'));
}

async function assertSafeExternalUrl(rawUrl: string, buildError: () => Error): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw buildError();
  }

  if (!isAllowedProtocol(parsed.protocol)) {
    throw buildError();
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (!hostname || FORBIDDEN_HOSTNAMES.has(hostname)) {
    throw buildError();
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isPrivateIpv4(hostname)) {
    throw buildError();
  }

  if (ipVersion === 6 && isPrivateIpv6(hostname)) {
    throw buildError();
  }

  const addresses = await resolveAllAddresses(hostname, buildError);
  if (addresses.some((address) => isPrivateAddress(address))) {
    throw buildError();
  }

  return parsed;
}

async function resolveAllAddresses(hostname: string, buildError: () => Error): Promise<string[]> {
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw buildError();
    }
    return records.map((record) => record.address);
  } catch {
    throw buildError();
  }
}

function isPrivateAddress(address: string): boolean {
  const ipVersion = isIP(address);
  return (ipVersion === 4 && isPrivateIpv4(address)) || (ipVersion === 6 && isPrivateIpv6(address));
}

function isAllowedProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  const [a, b] = parts;

  return a === 10
    || a === 127
    || a === 0
    || (a === 100 && b !== undefined && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b !== undefined && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && b !== undefined && (b === 18 || b === 19));
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:')
    || normalized.startsWith('fe90:')
    || normalized.startsWith('fea0:')
    || normalized.startsWith('feb0:');
}
