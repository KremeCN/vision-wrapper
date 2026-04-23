import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { RemoteImageUrlPolicy } from '../config.js';
import { BadRequestError, UpstreamError } from '../http/errors.js';

const FORBIDDEN_HOSTNAMES = new Set(['localhost']);

export type SafeResolvedUrl = {
  url: URL;
  address: string;
};

type ExternalUrlOptions = {
  policy: RemoteImageUrlPolicy;
};

export async function assertSafeClientImageUrl(rawUrl: string, options: ExternalUrlOptions): Promise<SafeResolvedUrl> {
  return assertSafeExternalUrl(
    rawUrl,
    options,
    () => new BadRequestError(buildClientImageUrlMessage(options.policy), 'unsafe_image_url', 'messages')
  );
}

export async function assertSafeUpstreamImageUrl(rawUrl: string, options: ExternalUrlOptions): Promise<SafeResolvedUrl> {
  return assertSafeExternalUrl(
    rawUrl,
    options,
    () => new UpstreamError(502, buildUpstreamImageUrlMessage(options.policy), 'unsafe_upstream_image_url')
  );
}

async function assertSafeExternalUrl(rawUrl: string, options: ExternalUrlOptions, buildError: () => Error): Promise<SafeResolvedUrl> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw buildError();
  }

  if (!isAllowedProtocol(parsed.protocol, options.policy)) {
    throw buildError();
  }

  const hostname = normalizeHostname(parsed.hostname);
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

  return {
    url: parsed,
    address: addresses[0] as string
  };
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

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function isPrivateAddress(address: string): boolean {
  const ipVersion = isIP(address);
  return (ipVersion === 4 && isPrivateIpv4(address)) || (ipVersion === 6 && isPrivateIpv6(address));
}

function isAllowedProtocol(protocol: string, policy: RemoteImageUrlPolicy): boolean {
  if (policy === 'disabled') {
    return false;
  }

  if (policy === 'https_only') {
    return protocol === 'https:';
  }

  return protocol === 'http:' || protocol === 'https:';
}

function buildClientImageUrlMessage(policy: RemoteImageUrlPolicy): string {
  switch (policy) {
    case 'disabled':
      return 'Remote image URLs are disabled';
    case 'https_only':
      return 'Image input URL must be a public https address';
    case 'http_and_https':
      return 'Image input URL must be a public http/https address';
  }
}

function buildUpstreamImageUrlMessage(policy: RemoteImageUrlPolicy): string {
  switch (policy) {
    case 'disabled':
      return 'Upstream returned a remote image URL but remote image downloads are disabled';
    case 'https_only':
      return 'Upstream returned a non-public or non-https image URL';
    case 'http_and_https':
      return 'Upstream returned an unsafe image URL';
  }
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
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
}
