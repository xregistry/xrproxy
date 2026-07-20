/**
 * Deterministic Hugging Face Hub API fixtures for unit and integration tests.
 * All data is static – tests NEVER make real network calls.
 */

export const FIXTURE_MODEL_BERT: Readonly<Record<string, unknown>> = {
  id: 'google-bert/bert-base-uncased',
  modelId: 'bert-base-uncased',
  author: 'google-bert',
  sha: 'a86a4d9a4e7bfed432ab38a4462a66bc50f34f49',
  lastModified: '2021-05-10T08:44:05.000Z',
  private: false,
  gated: false,
  disabled: false,
  downloads: 12_456_789,
  likes: 1_892,
  pipeline_tag: 'fill-mask',
  library_name: 'transformers',
  tags: ['pytorch', 'tf', 'jax', 'bert', 'fill-mask', 'en'],
  gitalyDefaultBranch: 'main',
};


export const FIXTURE_MODEL_UNNAMESPACED: Readonly<Record<string, unknown>> = {
  id: 'true-bare-model',
  sha: 'cccc3333dddd4444eeee5555ffff6666aaaa7777',
  lastModified: '2023-03-28T14:22:11.000Z',
  private: false,
  gated: false,
  downloads: 1000,
  likes: 10,
  pipeline_tag: 'text-generation',
  library_name: 'transformers',
  tags: ['transformers'],
  gitalyDefaultBranch: 'main',
};

/** A model whose default branch is NOT 'main' – used to verify non-main branch handling. */
export const FIXTURE_MODEL_ALTBRANCH: Readonly<Record<string, unknown>> = {
  id: 'test-org/model-with-master-branch',
  author: 'test-org',
  sha: 'bbbb2222cccc3333dddd4444eeee5555ffff6666',
  lastModified: '2023-01-01T00:00:00.000Z',
  private: false,
  gated: false,
  pipeline_tag: 'text-classification',
  library_name: 'transformers',
  tags: [],
  gitalyDefaultBranch: 'master',  // non-main default branch
};

export const FIXTURE_MODEL_GPT2: Readonly<Record<string, unknown>> = {
  id: 'openai-community/gpt2',
  author: 'openai-community',
  sha: 'e7da7f221d5bf496a48136c0cd264e630fe9fcc8',
  lastModified: '2023-03-28T14:22:11.000Z',
  private: false,
  gated: false,
  downloads: 8_123_456,
  likes: 1_234,
  pipeline_tag: 'text-generation',
  library_name: 'transformers',
  tags: ['pytorch', 'tf', 'jax', 'gpt2', 'text-generation', 'en'],
  gitalyDefaultBranch: 'main',
};

export const FIXTURE_MODEL_DOTTED_OWNER: Readonly<Record<string, unknown>> = {
  id: 'org.example/dotted-model',
  author: 'org.example',
  sha: '2222333344445555666677778888999900001111',
  lastModified: '2024-03-01T00:00:00.000Z',
  private: false,
  gated: false,
  tags: [],
  gitalyDefaultBranch: 'main',
};

export const FIXTURE_MODEL_GATED: Readonly<Record<string, unknown>> = {
  id: 'gated-org/public-metadata',
  author: 'gated-org',
  sha: '99990000aaaabbbbccccddddeeeeffff11112222',
  lastModified: '2025-01-01T00:00:00.000Z',
  private: false,
  gated: true,
  downloads: 12,
  likes: 3,
  tags: ['gated'],
  gitalyDefaultBranch: 'main',
};

export const FIXTURE_MODEL_GOOGLE_SECOND: Readonly<Record<string, unknown>> = {
  id: 'google-bert/second-model',
  author: 'google-bert',
  sha: '1111222233334444555566667777888899990000',
  lastModified: '2024-02-01T00:00:00.000Z',
  private: false,
  gated: false,
  tags: [],
  gitalyDefaultBranch: 'main',
};

export const FIXTURE_DATASET_SQUAD: Readonly<Record<string, unknown>> = {
  id: 'rajpurkar/squad',
  author: 'rajpurkar',
  sha: 'c3a01e27bb9f5b7c5674c9878e8f28cb4b97f1ad',
  lastModified: '2022-07-12T09:15:33.000Z',
  private: false,
  gated: false,
  downloads: 5_654_321,
  likes: 875,
  tags: ['question-answering', 'en'],
  gitalyDefaultBranch: 'main',
};

export const FIXTURE_SPACE_GRADIO: Readonly<Record<string, unknown>> = {
  id: 'gradio/hello_world',
  author: 'gradio',
  sha: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0',
  lastModified: '2024-01-15T12:00:00.000Z',
  private: false,
  sdk: 'gradio',
  likes: 42,
  tags: ['gradio'],
  gitalyDefaultBranch: 'main',
};

export const FIXTURE_REFS_BERT: Readonly<Record<string, unknown>> = {
  branches: [
    { name: 'main', ref: 'refs/heads/main', targetCommit: 'a86a4d9a4e7bfed432ab38a4462a66bc50f34f49' },
    { name: 'dev', ref: 'refs/heads/dev', targetCommit: 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0' },
  ],
  tags: [
    { name: 'v1.0', ref: 'refs/tags/v1.0', targetCommit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555' },
  ],
  converts: [],
};

export const FIXTURE_REFS_ALTBRANCH: Readonly<Record<string, unknown>> = {
  branches: [
    { name: 'master', ref: 'refs/heads/master', targetCommit: 'bbbb2222cccc3333dddd4444eeee5555ffff6666' },
  ],
  tags: [],
  converts: [],
};

/** SHA that exists deep in history (NOT on page 1 of 'main'). */
export const DEEP_COMMIT_SHA = 'dddd4444eeee5555ffff6666aaaa1111bbbb2222';

export const FIXTURE_COMMITS_BERT: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  {
    id: 'a86a4d9a4e7bfed432ab38a4462a66bc50f34f49',
    title: 'Update model card',
    message: 'Update model card with evaluation metrics',
    authors: [{ user: 'google-bert' }],
    date: '2021-05-10T08:44:05.000Z',
  },
  {
    id: 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0',
    title: 'Initial commit',
    message: 'Add BERT base uncased weights',
    authors: [{ user: 'google-bert' }],
    date: '2021-04-01T10:00:00.000Z',
  },
];

/** Fixture for looking up a deep commit by SHA (not on page-1 of main). */
export const FIXTURE_COMMITS_BERT_DEEP: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  {
    id: DEEP_COMMIT_SHA,
    title: 'Deep historical commit',
    message: 'A commit deep in history not on page 1',
    authors: [{ user: 'google-bert' }],
    date: '2019-11-01T00:00:00.000Z',
  },
];

export const FIXTURE_COMMITS_ALTBRANCH: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  {
    id: 'bbbb2222cccc3333dddd4444eeee5555ffff6666',
    title: 'Initial commit on master',
    message: 'Initial model weights',
    authors: [{ user: 'test-org' }],
    date: '2023-01-01T00:00:00.000Z',
  },
];

function incompleteListSummary(repo: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const summary = { ...repo };
  delete summary['author'];
  delete summary['sha'];
  return summary;
}

export const FIXTURE_MODELS_LIST: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  incompleteListSummary(FIXTURE_MODEL_BERT),
  FIXTURE_MODEL_GPT2,
  incompleteListSummary(FIXTURE_MODEL_GOOGLE_SECOND),
  FIXTURE_MODEL_DOTTED_OWNER,
  FIXTURE_MODEL_GATED,
  FIXTURE_MODEL_UNNAMESPACED,
];

export const FIXTURE_DATASETS_LIST: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  FIXTURE_DATASET_SQUAD,
];

export const FIXTURE_SPACES_LIST: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  FIXTURE_SPACE_GRADIO,
];
