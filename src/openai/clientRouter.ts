import type { ImageModelRoute } from '../config.js';
import { BadRequestError } from '../http/errors.js';
import { OpenAiClient } from './client.js';

export type RoutedOpenAiClient = {
  client: OpenAiClient;
  route: ImageModelRoute;
};

export class OpenAiClientRouter {
  private readonly clients = new Map<string, OpenAiClient>();

  constructor(
    private readonly routes: Map<string, ImageModelRoute>,
    private readonly timeoutMs: number
  ) {}

  get(model: string): RoutedOpenAiClient {
    const route = this.routes.get(model);
    if (!route) {
      throw new BadRequestError('This proxy only supports configured image models', 'unsupported_model', 'model');
    }

    return {
      route,
      client: this.getClient(route)
    };
  }

  private getClient(route: ImageModelRoute): OpenAiClient {
    const key = `${route.upstreamBaseUrl}\n${route.upstreamApiKey}`;
    const cached = this.clients.get(key);
    if (cached) {
      return cached;
    }

    const client = new OpenAiClient(route.upstreamBaseUrl, route.upstreamApiKey, this.timeoutMs);
    this.clients.set(key, client);
    return client;
  }
}
