/**
 * git.ts — GitHub API integration for repo awareness
 *
 * Reads files from the owner's GitHub repo via the REST API.
 * Falls back to FILES KV if no GitHub token is configured.
 */

export interface RepoFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  sha: string;
}

export interface FileContent {
  path: string;
  content: string;
  encoding: string;
  size: number;
}

const GITHUB_API = 'https://api.github.com';

/** List files in the repo (or a subdirectory) */
export async function listFiles(
  githubToken: string | undefined,
  githubRepo: string | undefined,
  filesKv: KVNamespace | undefined,
  path: string = ''
): Promise<RepoFile[]> {
  // Try GitHub API first
  if (githubToken && githubRepo) {
    try {
      return await listGithubFiles(githubToken, githubRepo, path);
    } catch {
      // Fall through to KV
    }
  }

  // Fall back to KV file store
  if (filesKv) {
    return await listKvFiles(filesKv, path);
  }

  return [];
}

/** Read a file's content */
export async function readFile(
  githubToken: string | undefined,
  githubRepo: string | undefined,
  filesKv: KVNamespace | undefined,
  path: string
): Promise<FileContent | null> {
  if (githubToken && githubRepo) {
    try {
      return await readGithubFile(githubToken, githubRepo, path);
    } catch {
      // Fall through to KV
    }
  }

  if (filesKv) {
    const content = await filesKv.get(`file:${path}`);
    if (content === null) return null;
    return {
      path,
      content,
      encoding: 'utf-8',
      size: new TextEncoder().encode(content).length,
    };
  }

  return null;
}

/** Write a file (KV only — GitHub writes via Git commits) */
export async function writeFile(
  filesKv: KVNamespace,
  path: string,
  content: string
): Promise<void> {
  await filesKv.put(`file:${path}`, content);
  // Update file index
  const raw = await filesKv.get('file_index');
  const index = raw ? JSON.parse(raw) : [];
  const existing = index.findIndex((f: RepoFile) => f.path === path);
  const entry: RepoFile = {
    name: path.split('/').pop() ?? path,
    path,
    type: 'file',
    size: new TextEncoder().encode(content).length,
    sha: 'kv',
  };
  if (existing >= 0) {
    index[existing] = entry;
  } else {
    index.push(entry);
  }
  await filesKv.put('file_index', JSON.stringify(index));
}

/** Delete a file from KV */
export async function deleteFile(
  filesKv: KVNamespace,
  path: string
): Promise<void> {
  await filesKv.delete(`file:${path}`);
  const raw = await filesKv.get('file_index');
  if (raw) {
    const index = JSON.parse(raw);
    const filtered = index.filter((f: RepoFile) => f.path !== path);
    await filesKv.put('file_index', JSON.stringify(filtered));
  }
}

// --- GitHub API helpers ---

async function listGithubFiles(
  token: string,
  repo: string,
  path: string
): Promise<RepoFile[]> {
  const url = path
    ? `${GITHUB_API}/repos/${repo}/contents/${path}`
    : `${GITHUB_API}/repos/${repo}/contents`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'personallog-ai',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }

  const data = await res.json() as Array<{
    name: string;
    path: string;
    type: string;
    size: number;
    sha: string;
  }>;

  return data.map(item => ({
    name: item.name,
    path: item.path,
    type: item.type as 'file' | 'dir',
    size: item.size,
    sha: item.sha,
  }));
}

async function readGithubFile(
  token: string,
  repo: string,
  path: string
): Promise<FileContent> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'personallog-ai',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status}`);
  }

  const data = await res.json() as {
    content: string;
    encoding: string;
    size: number;
    path: string;
  };

  const content = data.encoding === 'base64'
    ? atob(data.content.replace(/\n/g, ''))
    : data.content;

  return {
    path: data.path,
    content,
    encoding: 'utf-8',
    size: data.size,
  };
}

async function listKvFiles(
  kv: KVNamespace,
  path: string
): Promise<RepoFile[]> {
  const raw = await kv.get('file_index');
  if (!raw) return [];
  try {
    const index = JSON.parse(raw) as RepoFile[];
    if (!path) return index;
    // Filter by path prefix
    const prefix = path.endsWith('/') ? path : path + '/';
    return index.filter(f => f.path.startsWith(prefix));
  } catch {
    return [];
  }
}
