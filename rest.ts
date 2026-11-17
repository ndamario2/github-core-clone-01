// rest.ts — the REST v3 surface under /api/v3. JSON always, a non-empty
// X-GitHub-Request-Id on every reply (set by the app layer), error bodies of the
// shape {"message": "<string>"}. Bearer auth from MAKEFUN_SHOP_TOKEN: every
// endpoint except GET / and GET /meta requires it; a repo under any owner other
// than the token's login is a 404, never a 403.

import { parseCommit, parseTree, type GitObject } from './gitobj.ts';
import {
  Store,
  type Issue,
  type IssueComment,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  origin: string;
  body: Buffer;
  authed: boolean;
}

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

const json = (status: number, value: unknown, headers?: Record<string, string>): RestResponse => ({
  status,
  headers,
  body: JSON.stringify(value),
});

const err = (status: number, message: string): RestResponse => json(status, { message });

function parseBody(request: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: RestResponse } {
  if (request.body.length === 0) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(request.body.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, response: err(400, 'request body must be a JSON object') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: err(400, 'malformed JSON') };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): { pageItems: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

function linkHeader(request: RestRequest, page: number, perPage: number): Record<string, string> {
  return { Link: `<${request.origin}${request.pathname}?page=${page}&per_page=${perPage}>; rel="next"` };
}

/** Split a `Name <email> epoch tz` ident into its parts. */
function parseIdent(ident: string): { name: string; email: string; epoch: number } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (match === null) return { name: ident, email: '', epoch: 0 };
  return { name: match[1]!, email: match[2]!, epoch: Number(match[3]) };
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

function repoShape(store: Store, repo: Repo, request: RestRequest): Record<string, unknown> {
  const owner = store.viewer;
  return {
    id: repo.id,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${owner.login}/${repo.name}`,
    owner: { login: owner.login, id: owner.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `${request.origin}/${owner.login}/${repo.name}`,
    clone_url: `${request.origin}/${owner.login}/${repo.name}.git`,
    git_url: `${request.origin}/${owner.login}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${owner.login}/${repo.name}.git`,
  };
}

function labelShape(label: Label): Record<string, unknown> {
  return {
    id: Buffer.from(`label:${label.name}`, 'utf8').toString('base64'),
    node_id: Buffer.from(`label:${label.name}`, 'utf8').toString('base64'),
    name: label.name,
    color: label.color,
    description: label.description,
  };
}

function issueShape(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelShape(label) : { name };
    }),
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: store.listComments(repo, issue.number).length,
  };
}

function pullShape(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = store.viewer.login;
  return {
    id: pull.id,
    node_id: store.pullGlobalId(repo, pull),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}`, user: { login: owner, id: store.viewer.id, type: 'User' } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}`, user: { login: owner, id: store.viewer.id, type: 'User' } },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: !store.pullConflicts(repo, pull),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commentShape(store: Store, repo: Repo, issueNumber: number, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: store.commentGlobalId(repo, issueNumber, comment),
    body: comment.body,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function commitShape(object: GitObject, oid: string): Record<string, unknown> {
  const commit = parseCommit(object.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  const stamp = (epoch: number): string => new Date(epoch * 1000).toISOString();
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author: { name: author.name, email: author.email, date: stamp(author.epoch) },
      committer: { name: committer.name, email: committer.email, date: stamp(committer.epoch) },
    },
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

/** The file at `path` in the tree of `tip`, or undefined. */
function fileAtPath(store: Store, repo: Repo, tip: string, path: string): { oid: string; data: Buffer } | undefined {
  const tipObject = repo.objects.get(tip);
  if (tipObject === undefined || tipObject.type !== 'commit') return undefined;
  const flat = store.flattenTree(repo, parseCommit(tipObject.data).tree);
  const entry = flat.get(path);
  if (entry === undefined) return undefined;
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined || blob.type !== 'blob') return undefined;
  return { oid: entry.oid, data: blob.data };
}

/** The tree oid of the directory `path` ('' = root) under the tree `rootTree`. */
function treeOidAtPath(repo: Repo, rootTree: string, path: string): string | undefined {
  if (path === '') return rootTree;
  let current = rootTree;
  for (const part of path.split('/')) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
    if (entry === undefined) return undefined;
    current = entry.oid;
  }
  return current;
}

export function handleRest(store: Store, request: RestRequest): RestResponse {
  const segments = request.pathname.split('/').filter((part) => part !== '');
  // /api/v3/...
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') {
    return err(404, 'Not Found');
  }
  const rest = segments.slice(2);
  const method = request.method;

  // Public endpoints: no auth.
  if (rest.length === 0 && method === 'GET') {
    return json(200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0' });
  }
  if (!request.authed) return err(401, 'Requires authentication');

  const viewer = store.viewer;

  // GET /user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    return json(200, { login: viewer.login, id: viewer.id, type: 'User', name: viewer.name });
  }

  // /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageParams(request.query);
      const repos = store.listRepos().sort((a, b) => a.id - b.id);
      const { pageItems, hasNext } = paginate(repos, page, perPage);
      return json(200, pageItems.map((repo) => repoShape(store, repo, request)), hasNext ? linkHeader(request, page + 1, perPage) : undefined);
    }
    if (method === 'POST') {
      const parsed = parseBody(request);
      if (!parsed.ok) return parsed.response;
      const name = asString(parsed.value.name);
      if (name === undefined || name.length === 0) return err(422, 'name is required');
      const description = asString(parsed.value.description) ?? '';
      const isPrivate = asBool(parsed.value.private) ?? false;
      const repo = store.createRepo(name, description, isPrivate);
      if (repo === null) return err(422, 'name already exists on this account');
      return json(201, repoShape(store, repo, request));
    }
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const repoName = rest[2]!;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return err(404, 'Not Found');
    const tail = rest.slice(3);

    // The repo itself.
    if (tail.length === 0) {
      if (method === 'GET') return json(200, repoShape(store, repo, request));
      if (method === 'PATCH') {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.response;
        const name = asString(parsed.value.name);
        if (name !== undefined && name.length > 0 && name !== repo.name) {
          if (store.getRepo(owner, name) !== undefined) return err(422, 'name already exists on this account');
          store.repos.delete(`${owner}/${repo.name}`);
          repo.name = name;
          store.repos.set(`${owner}/${repo.name}`, repo);
        }
        const description = asString(parsed.value.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBool(parsed.value.private);
        if (isPrivate !== undefined) repo.private = isPrivate;
        return json(200, repoShape(store, repo, request));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204, body: '' };
      }
      return err(404, 'Not Found');
    }

    // /branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([name]) => name.startsWith('refs/heads/'))
          .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        return json(200, branches);
      }
      if (tail.length === 2 && method === 'GET') {
        const tip = repo.refs.get(`refs/heads/${tail[1]}`);
        if (tip === undefined) return err(404, 'Not Found');
        return json(200, { name: tail[1], commit: { sha: tip }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // /commits
    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const ref = request.query.get('sha') ?? repo.defaultBranch;
        const tip = store.resolveCommit(repo, ref);
        if (tip === undefined) return err(404, 'Not Found');
        const history = store.history(repo, tip);
        return json(200, history.map((oid) => commitShape(repo.objects.get(oid)!, oid)));
      }
      return err(404, 'Not Found');
    }

    // /contents/{path...}
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      const branch = request.query.get('ref') ?? undefined;
      if (method === 'GET') {
        const tip = store.resolveCommit(repo, branch ?? repo.defaultBranch);
        if (tip === undefined) return err(404, 'Not Found');
        const file = fileAtPath(store, repo, tip, path);
        if (file !== undefined) {
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: path.split('/').pop() ?? path,
            path,
            content: file.data.toString('base64'),
            sha: file.oid,
          });
        }
        const tipObject = repo.objects.get(tip);
        if (tipObject === undefined || tipObject.type !== 'commit') return err(404, 'Not Found');
        const rootTree = parseCommit(tipObject.data).tree;
        const dirTree = treeOidAtPath(repo, rootTree, path);
        if (dirTree !== undefined) {
          const entries = store.listTreeRecursive(repo, dirTree, false);
          if (entries !== undefined) {
            return json(200, entries.map((entry) => ({ type: entry.type === 'tree' ? 'dir' : 'file', name: entry.path.split('/').pop() ?? entry.path, path: path === '' ? entry.path : `${path}/${entry.path}`, sha: entry.sha, size: entry.size })));
          }
        }
        return err(404, 'Not Found');
      }
      if (method === 'PUT' || method === 'DELETE') {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.response;
        const bodyBranch = asString(parsed.value.branch);
        const targetBranch = bodyBranch ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${targetBranch}`);
        // An explicitly named branch must exist; the default branch may be
        // unborn, in which case the put creates the repo's first commit.
        if (tip === undefined && bodyBranch !== undefined) return err(404, 'Not Found');
        if (method === 'PUT') {
          const content = asString(parsed.value.content);
          if (content === undefined) return err(422, 'content is required');
          const message = asString(parsed.value.message) ?? `Update ${path}`;
          const data = Buffer.from(content, 'base64');
          const existing = tip === undefined ? undefined : fileAtPath(store, repo, tip, path);
          const sha = asString(parsed.value.sha);
          if (existing !== undefined) {
            if (sha === undefined || sha !== existing.oid) return err(409, 'sha does not match the current file');
          } else if (sha !== undefined) {
            return err(409, 'sha does not match the current file');
          }
          const files = new Map<string, Buffer | null>();
          files.set(path, data);
          const { commitSha } = store.commitOnBranch(repo, targetBranch, message, files);
          const after = fileAtPath(store, repo, commitSha, path)!;
          return json(existing !== undefined ? 200 : 201, {
            content: { type: 'file', encoding: 'base64', size: after.data.length, name: path.split('/').pop() ?? path, path, content: after.data.toString('base64'), sha: after.oid },
            commit: { sha: commitSha, message },
          });
        }
        // DELETE
        if (tip === undefined) return err(404, 'Not Found');
        const existing = fileAtPath(store, repo, tip, path);
        if (existing === undefined) return err(404, 'Not Found');
        const sha = asString(parsed.value.sha);
        if (sha === undefined || sha !== existing.oid) return err(409, 'sha does not match the current file');
        const message = asString(parsed.value.message) ?? `Delete ${path}`;
        const files = new Map<string, Buffer | null>();
        files.set(path, null);
        const { commitSha } = store.commitOnBranch(repo, targetBranch, message, files);
        return json(200, { commit: { sha: commitSha, message } });
      }
      return err(404, 'Not Found');
    }

    // /labels
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') return json(200, [...repo.labels.values()].map(labelShape));
      if (tail.length === 1 && method === 'POST') {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.response;
        const name = asString(parsed.value.name);
        if (name === undefined || name.length === 0) return err(422, 'name is required');
        const color = asString(parsed.value.color) ?? 'ededed';
        const description = asString(parsed.value.description) ?? '';
        if (repo.labels.has(name)) return err(422, 'label already exists');
        const label: Label = { name, color, description };
        repo.labels.set(name, label);
        return json(201, labelShape(label));
      }
      return err(404, 'Not Found');
    }

    // /issues
    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'GET') {
        const state = request.query.get('state') ?? 'open';
        const issues = store.listIssues(repo, {
          state,
          sort: request.query.get('sort') ?? undefined,
          direction: request.query.get('direction') ?? undefined,
        });
        const { page, perPage } = pageParams(request.query);
        const { pageItems, hasNext } = paginate(issues, page, perPage);
        return json(200, pageItems.map((issue) => issueShape(store, repo, issue)), hasNext ? linkHeader(request, page + 1, perPage) : undefined);
      }
      if (tail.length === 1 && method === 'POST') {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.response;
        const title = asString(parsed.value.title);
        if (title === undefined || title.length === 0) return err(422, 'title is required');
        const bodyText = asString(parsed.value.body) ?? '';
        const labels = Array.isArray(parsed.value.labels)
          ? (parsed.value.labels as unknown[]).filter((label): label is string => typeof label === 'string')
          : [];
        for (const name of labels) {
          if (!repo.labels.has(name)) return err(422, `label does not exist: ${name}`);
        }
        const issue = store.createIssue(repo, title, bodyText, labels);
        return json(201, issueShape(store, repo, issue));
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      if (tail.length === 2 && method === 'GET') {
        const issue = store.findIssue(repo, number);
        if (issue === undefined) return err(404, 'Not Found');
        return json(200, issueShape(store, repo, issue));
      }
      if (tail.length === 2 && method === 'PATCH') {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.response;
        const issue = store.findIssue(repo, number);
        if (issue === undefined) return err(404, 'Not Found');
        const state = asString(parsed.value.state);
        if (state !== undefined) {
          if (state !== 'open' && state !== 'closed') return err(422, 'state must be open or closed');
          issue.state = state;
        }
        const title = asString(parsed.value.title);
        if (title !== undefined) issue.title = title;
        const bodyText = asString(parsed.value.body);
        if (bodyText !== undefined) issue.body = bodyText;
        const labels = parsed.value.labels;
        if (Array.isArray(labels)) {
          const names = (labels as unknown[]).filter((label): label is string => typeof label === 'string');
          for (const name of names) {
            if (!repo.labels.has(name)) return err(422, `label does not exist: ${name}`);
          }
          issue.labels = names;
        }
        issue.updatedAt = store.tick().iso;
        return json(200, issueShape(store, repo, issue));
      }
      if (tail.length === 3 && tail[2] === 'comments' && method === 'GET') {
        const issue = store.findIssue(repo, number);
        if (issue === undefined) return err(404, 'Not Found');
        return json(200, store.listComments(repo, number).map((comment) => commentShape(store, repo, number, comment)));
      }
      if (tail.length === 3 && tail[2] === 'comments' && method === 'POST') {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.response;
        const bodyText = asString(parsed.value.body);
        if (bodyText === undefined) return err(422, 'body is required');
        const comment = store.createComment(repo, number, bodyText);
        if (comment === null) return err(404, 'Not Found');
        return json(201, commentShape(store, repo, number, comment));
      }
      return err(404, 'Not Found');
    }

    // /pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'GET') {
        const state = request.query.get('state') ?? 'open';
        const pulls = store.listPulls(repo, state);
        const { page, perPage } = pageParams(request.query);
        const { pageItems, hasNext } = paginate(pulls, page, perPage);
        return json(200, pageItems.map((pull) => pullShape(store, repo, pull)), hasNext ? linkHeader(request, page + 1, perPage) : undefined);
      }
      if (tail.length === 1 && method === 'POST') {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.response;
        const title = asString(parsed.value.title);
        const head = asString(parsed.value.head);
        const base = asString(parsed.value.base);
        if (title === undefined || title.length === 0) return err(422, 'title is required');
        if (head === undefined || base === undefined) return err(422, 'head and base are required');
        const bodyText = asString(parsed.value.body) ?? '';
        const result = store.createPull(repo, title, bodyText, head, base);
        if ('error' in result) return err(422, result.error);
        return json(201, pullShape(store, repo, result));
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      if (tail.length === 2 && method === 'GET') {
        const pull = store.findPull(repo, number);
        if (pull === undefined) return err(404, 'Not Found');
        return json(200, pullShape(store, repo, pull));
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const pull = store.findPull(repo, number);
        if (pull === undefined) return err(404, 'Not Found');
        return json(200, store.pullFiles(repo, pull).map((file) => ({ filename: file.path, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes })));
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const pull = store.findPull(repo, number);
        if (pull === undefined) return err(404, 'Not Found');
        const result = store.mergePull(repo, pull);
        if ('error' in result) return err(result.status, result.error);
        return json(200, { sha: result.sha, merged: true, message: result.message });
      }
      return err(404, 'Not Found');
    }

    // /git/refs, /git/trees, /git/commits, /git/blobs
    if (tail[0] === 'git') {
      if (tail[1] === 'refs' && method === 'POST' && tail.length === 2) {
        const parsed = parseBody(request);
        if (!parsed.ok) return parsed.response;
        const ref = asString(parsed.value.ref);
        const sha = asString(parsed.value.sha);
        if (ref === undefined || sha === undefined) return err(422, 'ref and sha are required');
        if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha } });
      }
      if (tail[1] === 'refs' && method === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
        const branch = tail.slice(3).join('/');
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return err(404, 'Not Found');
        return json(200, { ref: `refs/heads/${branch}`, object: { sha: tip } });
      }
      if (tail[1] === 'refs' && method === 'GET' && tail.length >= 4 && tail[2] === 'tags') {
        const tag = tail.slice(3).join('/');
        const tip = repo.refs.get(`refs/tags/${tag}`);
        if (tip === undefined) return err(404, 'Not Found');
        return json(200, { ref: `refs/tags/${tag}`, object: { sha: tip } });
      }
      if (tail[1] === 'trees' && method === 'GET' && tail.length === 3) {
        const oid = tail[2]!;
        const recursive = request.query.get('recursive') === '1';
        const entries = store.listTreeRecursive(repo, oid, recursive);
        if (entries === undefined) return err(404, 'Not Found');
        return json(200, { sha: oid, tree: entries });
      }
      if (tail[1] === 'commits' && method === 'GET' && tail.length === 3) {
        const object = repo.objects.get(tail[2]!);
        if (object === undefined || object.type !== 'commit') return err(404, 'Not Found');
        const commit = parseCommit(object.data);
        return json(200, { sha: tail[2], message: commit.message, tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) });
      }
      if (tail[1] === 'blobs' && method === 'GET' && tail.length === 3) {
        const object = repo.objects.get(tail[2]!);
        if (object === undefined || object.type !== 'blob') return err(404, 'Not Found');
        return json(200, { sha: tail[2]!, size: object.data.length, encoding: 'base64', content: object.data.toString('base64') });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
