import { HttpUpstreamClient } from '@xregistry/registry-core';
import {
  buildHubListUrl,
  encodeHubRepoPath,
  HuggingFaceClient,
  PREFIX_SCAN_MAX_REQUESTS,
  type HfRepoListEntry,
} from '../../src/hf-client';

describe('Hugging Face Hub URL construction', () => {
  it.each([
    ['models', 'google-bert/bert-base-uncased'],
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

  it('uses the exact author parameter for owner lookup, including dotted owners', async () => {
    const getJson = jest.fn().mockResolvedValue({ value: [{ id: 'org.example/model' }] });
    const client = new HuggingFaceClient({
      http: { getJson } as unknown as HttpUpstreamClient,
      baseUrl: 'https://huggingface.co',
    });
    const page = await client.listReposByOwner('models', 'org.example', { limit: 1 });
    expect(page.items.map(item => item.id)).toEqual(['org.example/model']);
    const url = new URL(getJson.mock.calls[0][0] as string);
    expect(url.searchParams.get('author')).toBe('org.example');
    expect(url.searchParams.has('search')).toBe(false);
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

  it('returns a full boundary page without requiring an extra sentinel request', async () => {
    const getJson = jest.fn().mockImplementation((url: string) => {
      const parsed = new URL(url);
      const skip = Number(parsed.searchParams.get('skip'));
      const all = Array.from({ length: 1_100 }, (_, i) => ({ id: `owner/model-${i}` }));
      return Promise.resolve({ value: all.slice(skip, skip + 100) });
    });
    const client = new HuggingFaceClient({
      http: { getJson } as unknown as HttpUpstreamClient,
      baseUrl: 'https://huggingface.co',
    });

    const page = await client.listReposByOwner('models', 'owner', { skip: 900, limit: 100 });

    expect(page.items).toHaveLength(100);
    expect(page.hasMore).toBe(false);
    expect(page.totalCount).toBeUndefined();
    expect(getJson).toHaveBeenCalledTimes(PREFIX_SCAN_MAX_REQUESTS);
  });

  it('marks namespace discovery beyond 1000 entries as incomplete', async () => {
    const getJson = jest.fn().mockImplementation((url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname !== '/api/models') return Promise.resolve({ value: [] });
      const skip = Number(parsed.searchParams.get('skip'));
      const all = Array.from({ length: 1_100 }, (_, i) => ({ id: `owner-${i}/model` }));
      return Promise.resolve({ value: all.slice(skip, skip + 100) });
    });
    const client = new HuggingFaceClient({
      http: { getJson } as unknown as HttpUpstreamClient,
      baseUrl: 'https://huggingface.co',
    });

    const discovery = await client.discoverNamespaces();

    expect(discovery.namespaces).toHaveLength(1_000);
    expect(discovery.complete).toBe(false);
    expect(discovery.completeTypes.models).toBe(false);
  });

  it('terminates an incomplete deep scan without inventing a continuation', async () => {
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

    const page = await client.listReposByPrefix('models', 'google/', { skip: 5_000, limit: 1 });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.totalCount).toBeUndefined();
    expect(getJson).toHaveBeenCalledTimes(PREFIX_SCAN_MAX_REQUESTS);
  });
});
