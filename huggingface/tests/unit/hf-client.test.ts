import { HttpUpstreamClient } from '@xregistry/registry-core';
import {
  buildHubListUrl,
  encodeHubRepoPath,
  HuggingFaceClient,
  PREFIX_SCAN_MAX_REQUESTS,
  PrefixSearchLimitError,
  type HfRepoListEntry,
} from '../../src/hf-client';

describe('Hugging Face Hub URL construction', () => {
  it.each([
    ['models', 'google/bert-base-uncased'],
    ['datasets', 'rajpurkar/squad'],
    ['spaces', 'gradio/hello_world'],
  ])('preserves the namespace separator for %s IDs', (_type, repoId) => {
    expect(encodeHubRepoPath(repoId)).toBe(repoId);
  });

  it('encodes unsafe characters within each path segment', () => {
    expect(encodeHubRepoPath('owner/repo name')).toBe('owner/repo%20name');
  });

  it('maps viewer prefix search while preserving Hub pagination', () => {
    const url = new URL(buildHubListUrl('https://huggingface.co/', 'models', {
      limit: 25,
      skip: 50,
      search: 'meta-llama/',
    }));
    expect(url.pathname).toBe('/api/models');
    expect(url.searchParams.get('search')).toBe('meta-llama/');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('skip')).toBe('50');
  });

  it('uses the Hub commit API zero-based first page', async () => {
    const getJson = jest.fn().mockResolvedValue({ value: [] });
    const client = new HuggingFaceClient({
      http: { getJson } as unknown as HttpUpstreamClient,
      baseUrl: 'https://huggingface.co',
    });

    await client.listCommits('models', 'openai-community/gpt2', 'main');

    const url = new URL(getJson.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/api/models/openai-community/gpt2/commits/main');
    expect(url.searchParams.get('p')).toBe('0');
  });

  it('paginates over case-insensitive prefix matches, not broad search results', async () => {
    const firstPage: HfRepoListEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: i === 40 ? 'Google/first' : `unrelated/model-${i}`,
    }));
    const getJson = jest.fn()
      .mockResolvedValueOnce({ value: firstPage })
      .mockResolvedValueOnce({
        value: [
          { id: 'google/second' },
          { id: 'GOOGLE/third' },
          { id: 'contains-google-but-not-prefix' },
        ],
      });
    const client = new HuggingFaceClient({
      http: { getJson } as unknown as HttpUpstreamClient,
      baseUrl: 'https://huggingface.co',
    });

    const page = await client.listReposByPrefix('models', 'google/', {
      skip: 1,
      limit: 1,
    });

    expect(page.items.map(item => item.id)).toEqual(['google/second']);
    expect(page.hasMore).toBe(true);
    expect(getJson).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(getJson.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get('search')).toBe('google/');
    expect(secondUrl.searchParams.get('skip')).toBe('100');
  });

  it('stops when an upstream page makes no progress', async () => {
    const repeatedPage: HfRepoListEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: `unrelated/model-${i}`,
    }));
    const getJson = jest.fn().mockResolvedValue({ value: repeatedPage });
    const client = new HuggingFaceClient({
      http: { getJson } as unknown as HttpUpstreamClient,
      baseUrl: 'https://huggingface.co',
    });

    const page = await client.listReposByPrefix('models', 'google/', { limit: 1 });

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(getJson).toHaveBeenCalledTimes(2);
  });

  it('fails safely after the prefix scan request budget', async () => {
    const getJson = jest.fn().mockImplementation((url: string) => {
      const skip = Number(new URL(url).searchParams.get('skip'));
      return Promise.resolve({
        value: Array.from({ length: 100 }, (_, i) => ({
          id: `unrelated/model-${skip + i}`,
        })),
      });
    });
    const client = new HuggingFaceClient({
      http: { getJson } as unknown as HttpUpstreamClient,
      baseUrl: 'https://huggingface.co',
    });

    await expect(client.listReposByPrefix('models', 'google/', { limit: 1 }))
      .rejects.toBeInstanceOf(PrefixSearchLimitError);
    expect(getJson).toHaveBeenCalledTimes(PREFIX_SCAN_MAX_REQUESTS);
  });
});
