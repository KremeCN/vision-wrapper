export type OpenAiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'api_error';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly type: OpenAiErrorType,
    message: string,
    public readonly code?: string,
    public readonly param?: string
  ) {
    super(message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, code?: string, param?: string) {
    super(400, 'invalid_request_error', message, code, param);
  }
}

export class AuthenticationError extends HttpError {
  constructor(message: string, code?: string) {
    super(401, 'authentication_error', message, code);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string, code?: string) {
    super(404, 'invalid_request_error', message, code);
  }
}

export class RateLimitError extends HttpError {
  constructor(message = 'Rate limit exceeded', code = 'rate_limit_exceeded') {
    super(429, 'rate_limit_error', message, code);
  }
}

export class UpstreamError extends HttpError {
  constructor(statusCode: number, message: string, code?: string) {
    super(statusCode, 'api_error', message, code);
  }
}
