import { describe, expect, it } from 'vitest';

type ModelResponse = {
  id: string;
  object: 'model';
  created: number;
  owned_by: 'vision-wrapper';
};

function buildModelResponse(modelId: string): ModelResponse {
  return {
    id: modelId,
    object: 'model',
    created: 0,
    owned_by: 'vision-wrapper'
  };
}

function buildModelsResponse(models: Set<string>) {
  return {
    object: 'list',
    data: Array.from(models).map(buildModelResponse)
  };
}

describe('models response shape', () => {
  it('returns configured model aliases', () => {
    const response = buildModelsResponse(new Set(['gpt-image-1', 'my-image-model']));
    expect(response.object).toBe('list');
    expect(response.data).toHaveLength(2);
    expect(response.data[0]?.object).toBe('model');
    expect(response.data.map((model) => model.id)).toEqual(['gpt-image-1', 'my-image-model']);
  });

  it('returns a single model response shape', () => {
    const response = buildModelResponse('gpt-image-1');
    expect(response).toEqual({
      id: 'gpt-image-1',
      object: 'model',
      created: 0,
      owned_by: 'vision-wrapper'
    });
  });
});
