# vision-wrapper

A TypeScript + Fastify proxy that accepts OpenAI-compatible `/v1/chat/completions` requests for configured image models, rewrites them to an upstream OpenAI-compatible Images API, stores generated images locally, and returns markdown image URLs in a chat-completions-compatible response.

## Quick start

1. Copy `.env.example` to `.env`
2. Fill in `UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`, and `PROXY_API_KEYS`
3. Start the server:

```bash
npm install
npm run dev
```

For production builds:

```bash
npm run build
npm start
```

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `GET /v1/models/:id`
- `POST /v1/chat/completions`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `GET /files/*`
- `OPTIONS` on the routes above for CORS preflight

## Environment variables

```env
PORT=3000
HOST=0.0.0.0
PUBLIC_BASE_URL=http://localhost:3000
UPSTREAM_BASE_URL=http://your-upstream-openai-compatible-host/v1
UPSTREAM_API_KEY=
PROXY_API_KEYS=dev-proxy-key
IMAGE_MODEL_ALIASES=gpt-image-2
IMAGE_STORAGE_DIR=data/images
REQUEST_TIMEOUT_MS=300000
BODY_LIMIT_BYTES=20971520
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=10
MAX_PROMPT_CHARS=4000
CORS_ALLOW_ORIGIN=*
FILE_TTL_HOURS=168
STREAM_PROGRESS_LANGUAGE=en
REMOTE_IMAGE_URL_POLICY=https_only
LOG_LEVEL=info
```

## Behavior notes

- `PUBLIC_BASE_URL` is this proxy's public address for generated file URLs.
- `UPSTREAM_BASE_URL` must already end with `/v1`.
- The proxy appends `images/generations` to `UPSTREAM_BASE_URL`.
- `UPSTREAM_API_KEY` is the bearer token sent to the upstream provider.
- `CORS_ALLOW_ORIGIN` controls `Access-Control-Allow-Origin`.
- `/v1/models` and `/v1/models/:id` return the configured `IMAGE_MODEL_ALIASES`.
- `/v1/chat/completions` accepts common OpenAI chat fields like `temperature`, `top_p`, `max_tokens`, `metadata`, and ignores them when they do not affect image generation.
- Tool-related fields are explicitly rejected because this proxy only supports image requests.
- The proxy exposes exactly one configured model alias via `IMAGE_MODEL_ALIASES`.
- `/v1/images/generations` and `/v1/images/edits` are forwarded to the upstream OpenAI-compatible API.
- Image endpoints accept only the single exposed model alias and reject other model names.
- `stream=true` returns synthetic SSE chunks ending with `[DONE]`.
- In `/v1/chat/completions`, requests with image input parts are converted to upstream `images/edits`; requests without image input use `images/generations`.
- On stream failures, the proxy closes `</think>`, emits an `Error: ...` assistant message, then sends `[DONE]`.
- Streaming responses now include progress text wrapped in `<think>...</think>` before the final markdown image URL.
- `STREAM_PROGRESS_LANGUAGE` controls the progress text language inside `<think>` and supports `en` and `zh`.
- `BODY_LIMIT_BYTES` controls max request body size (defaults to 20MB for image-in-chat uploads).
- `REMOTE_IMAGE_URL_POLICY` controls remote image downloads for chat image inputs and upstream image URLs:
  - `https_only` — allow only public HTTPS URLs (default)
  - `http_and_https` — allow public HTTP and HTTPS URLs
  - `disabled` — reject all remote image URLs
- Generated images are stored under `IMAGE_STORAGE_DIR`.
- File metadata is written under `IMAGE_STORAGE_DIR/.meta`.

## Request examples

### List models

```bash
curl -s \
  -H "Authorization: Bearer dev-proxy-key" \
  http://127.0.0.1:3000/v1/models
```

### Fetch a model

```bash
curl -s \
  -H "Authorization: Bearer dev-proxy-key" \
  http://127.0.0.1:3000/v1/models/gpt-image-2
```

### Generate an image through chat completions

```bash
curl -s \
  -H "Authorization: Bearer dev-proxy-key" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/chat/completions \
  -d '{
    "model": "gpt-image-2",
    "messages": [
      { "role": "user", "content": "A cinematic orange cat sitting on the moon" }
    ]
  }'
```

Typical response shape:

```json
{
  "id": "chatcmpl_xxx",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "gpt-image-2",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "![generated image](http://localhost:3000/files/2026%2F04%2F23%2Fabc.png)"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

### Streaming example

```bash
curl -N \
  -H "Authorization: Bearer dev-proxy-key" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/chat/completions \
  -d '{
    "model": "gpt-image-2",
    "stream": true,
    "messages": [
      { "role": "user", "content": "An astronaut riding a bicycle on Mars" }
    ]
  }'
```

The stream emits assistant progress text first, then the final markdown image URL.

### Pass-through image generations

```bash
curl -s \
  -H "Authorization: Bearer dev-proxy-key" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/images/generations \
  -d '{
    "model": "gpt-image-2",
    "prompt": "A watercolor fox"
  }'
```

### Pass-through image edits

```bash
curl -s \
  -H "Authorization: Bearer dev-proxy-key" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3000/v1/images/edits \
  -d '{
    "model": "gpt-image-2",
    "prompt": "Add a sunrise background"
  }'
```

### Public image fetch

Returned file URLs are intentionally public so clients can render or save them without forwarding the API bearer token.

```bash
curl -I "http://127.0.0.1:3000/files/2026%2F04%2F23%2Fabc.png"
```

## Error examples

### Missing bearer token

```json
{
  "error": {
    "message": "Missing bearer token",
    "type": "authentication_error",
    "param": null,
    "code": "missing_bearer_token"
  }
}
```

### Unsupported model

```json
{
  "error": {
    "message": "This proxy only supports configured image models via /v1/chat/completions",
    "type": "invalid_request_error",
    "param": "model",
    "code": "unsupported_model"
  }
}
```

### Unsupported tools

```json
{
  "error": {
    "message": "Tools are not supported for image proxy requests",
    "type": "invalid_request_error",
    "param": null,
    "code": "unsupported_tools"
  }
}
```

## File cleanup

Expired files can be cleaned based on `FILE_TTL_HOURS`.

Build the project, then run:

```bash
npm run build
npm run cleanup
```

The server also runs a cleanup pass on startup.

## Docker

Build the image:

```bash
docker build -t vision-wrapper .
```

Run the container:

```bash
docker run --rm -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  vision-wrapper
```

On Windows PowerShell, mount the data directory like this instead:

```powershell
docker run --rm -p 3000:3000 `
  --env-file .env `
  -v ${PWD}/data:/app/data `
  vision-wrapper
```


```powershell
docker run --rm -p 3000:3000 `
  --env-file .env `
  -v ${PWD}/data:/app/data `
  vision-wrapper
```

## Validation

Recommended verification sequence:

```bash
npm run typecheck
npm test
npm run build
```

Then manually verify:
- `GET /healthz`
- `GET /v1/models`
- `GET /v1/models/:id`
- non-stream `POST /v1/chat/completions`
- stream `POST /v1/chat/completions`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- open returned `/files/*` URL in a browser or client
