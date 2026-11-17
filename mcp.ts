// mcp.ts — the MCP surface at /mcp: JSON-RPC 2.0 over Streamable HTTP, plain
// JSON answers. It speaks both the modern revision (server/discover) and the
// legacy handshake (initialize + notifications/initialized), offers the six
// canonical tools, and acts on the same store as REST and GraphQL.

import { Store, type Issue, type Pull, type Repo } from './store.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function pickArg(args: Record<string, unknown>, candidates: string[]): unknown {
  for (const candidate of candidates) {
    if (args[candidate] !== undefined) return args[candidate];
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

interface ToolOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  errorMessage?: string;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const suffix = name.toLowerCase();
  const viewer = store.viewer.login;
  if (suffix.endsWith('create_repo')) {
    const repoName = asText(pickArg(args, ['name', 'repo', 'repository']));
    if (repoName === undefined || repoName.length === 0) return { ok: false, errorMessage: 'missing required argument: name' };
    const description = asText(pickArg(args, ['description'])) ?? '';
    const isPrivate = typeof args.private === 'boolean' ? args.private : false;
    const repo = store.createRepo(repoName, description, isPrivate);
    if (repo === null) return { ok: false, errorMessage: 'name already exists on this account' };
    return { ok: true, result: { id: repo.id, name: repo.name, full_name: `${viewer}/${repo.name}`, private: repo.private, description: repo.description, default_branch: repo.defaultBranch } };
  }
  if (suffix.endsWith('get_repo')) {
    const owner = asText(pickArg(args, ['owner']));
    const repoName = asText(pickArg(args, ['repo', 'repository', 'name']));
    if (owner === undefined || repoName === undefined) return { ok: false, errorMessage: 'missing required argument: owner and repo' };
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { ok: false, errorMessage: 'Not Found' };
    return { ok: true, result: { id: repo.id, name: repo.name, full_name: `${owner}/${repo.name}`, private: repo.private, description: repo.description, default_branch: repo.defaultBranch } };
  }
  if (suffix.endsWith('create_issue')) {
    const owner = asText(pickArg(args, ['owner']));
    const repoName = asText(pickArg(args, ['repo', 'repository']));
    const title = asText(pickArg(args, ['title']));
    if (owner === undefined || repoName === undefined || title === undefined) return { ok: false, errorMessage: 'missing required argument: owner, repo, and title' };
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { ok: false, errorMessage: 'Not Found' };
    const body = asText(pickArg(args, ['body'])) ?? '';
    const issue: Issue = store.createIssue(repo, title, body, []);
    return { ok: true, result: { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels } };
  }
  if (suffix.endsWith('list_issues')) {
    const owner = asText(pickArg(args, ['owner']));
    const repoName = asText(pickArg(args, ['repo', 'repository']));
    if (owner === undefined || repoName === undefined) return { ok: false, errorMessage: 'missing required argument: owner and repo' };
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { ok: false, errorMessage: 'Not Found' };
    const state = asText(pickArg(args, ['state']));
    const issues = store.listIssues(repo, { state: state === undefined || state === 'all' ? 'all' : state });
    return { ok: true, result: { issues: issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels })) } };
  }
  if (suffix.endsWith('create_pull_request')) {
    const owner = asText(pickArg(args, ['owner']));
    const repoName = asText(pickArg(args, ['repo', 'repository']));
    const title = asText(pickArg(args, ['title']));
    const head = asText(pickArg(args, ['head', 'head_branch', 'headRef', 'head_ref']));
    const base = asText(pickArg(args, ['base', 'base_branch', 'baseRef', 'base_ref']));
    if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
      return { ok: false, errorMessage: 'missing required argument: owner, repo, title, head, and base' };
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { ok: false, errorMessage: 'Not Found' };
    const body = asText(pickArg(args, ['body'])) ?? '';
    const result = store.createPull(repo, title, body, head, base);
    if ('error' in result) return { ok: false, errorMessage: result.error };
    const pull: Pull = result;
    return { ok: true, result: { id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha } } };
  }
  if (suffix.endsWith('merge_pull_request')) {
    const owner = asText(pickArg(args, ['owner']));
    const repoName = asText(pickArg(args, ['repo', 'repository']));
    const pullNumber = asInt(pickArg(args, ['pull_number', 'pullNumber', 'pull_request_number', 'number']));
    if (owner === undefined || repoName === undefined || pullNumber === undefined) return { ok: false, errorMessage: 'missing required argument: owner, repo, and pull_number' };
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { ok: false, errorMessage: 'Not Found' };
    const pull = store.findPull(repo, pullNumber);
    if (pull === undefined) return { ok: false, errorMessage: 'Not Found' };
    const result = store.mergePull(repo, pull);
    if ('error' in result) return { ok: false, errorMessage: result.error };
    return { ok: true, result: { merged: true, sha: result.sha, message: result.message, number: pull.number } };
  }
  return { ok: false, errorMessage: `unknown tool: ${name}` };
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleOne(store: Store, request: JsonRpcRequest): { status: number; payload: Record<string, unknown> | null } {
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get an empty 202.
  if (request.id === undefined) {
    return { status: 202, payload: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      payload: rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return {
      status: 200,
      payload: rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, payload: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, payload: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => name.toLowerCase().endsWith(tool.name));
    if (!known) {
      return { status: 200, payload: rpcError(id, -32601, `unknown tool: ${name}`) };
    }
    const outcome = callTool(store, name, args);
    if (!outcome.ok) {
      return { status: 200, payload: rpcError(id, -32602, outcome.errorMessage ?? 'invalid params') };
    }
    const text = JSON.stringify(outcome.result ?? {});
    return {
      status: 200,
      payload: rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.result ?? {},
      }),
    };
  }
  return { status: 200, payload: rpcError(id, -32601, `unknown method: ${method}`) };
}

export interface McpResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export function handleMcp(store: Store, body: Buffer, authed: boolean, sessionId?: string): McpResponse {
  if (!authed) {
    return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
  }
  const headers: Record<string, string> = {};
  if (sessionId !== undefined) headers['Mcp-Session-Id'] = sessionId;
  if (Array.isArray(parsed)) {
    const responses: Array<Record<string, unknown>> = [];
    let status = 200;
    for (const request of parsed) {
      if (request === null || typeof request !== 'object') {
        responses.push(rpcError(null, -32600, 'invalid request'));
        continue;
      }
      const handled = handleOne(store, request as JsonRpcRequest);
      if (handled.payload !== null) responses.push(handled.payload);
      if (handled.status !== 200) status = handled.status;
    }
    return { status, headers, body: JSON.stringify(responses) };
  }
  if (parsed !== null && typeof parsed === 'object') {
    const handled = handleOne(store, parsed as JsonRpcRequest);
    if (handled.payload === null) return { status: handled.status, headers, body: '' };
    return { status: handled.status, headers, body: JSON.stringify(handled.payload) };
  }
  return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }) };
}

// Re-exported so the test harness can list the tool names.
export { TOOLS };
