// store.ts — the forge's whole state, in memory, deterministic.
//
// One Store holds every repository, its git objects and refs, its issues, pull
// requests, labels and comments. Nothing here reads a clock or a random source:
// every timestamp is the store's own logical clock (the scenario epoch plus a
// counter), every id is a counter, every global id is a base64 of a stable
// string. The same requests in the same order leave the same state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  commitHistory,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  peelTag,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';
import { viewerUser, type ScenarioUser } from './scenario.ts';

export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const SCENARIO_EPOCH_SEC = 1_735_689_600;
export const FORGE_IDENT_NAME = 'Forge';
export const FORGE_IDENT_EMAIL = 'forge@example.invalid';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  /** The trees the diff is measured against (frozen at creation). */
  baseTreeAtCreation: string;
  headTreeAtCreation: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  nextIssue: number;
  pulls: Pull[];
  nextPull: number;
  comments: Map<number, IssueComment[]>;
  nextCommentId: number;
  /** Flattened-tree cache, keyed by tree oid (trees are immutable). */
  treeCache: Map<string, Map<string, { oid: string; mode: string }>>;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
  changes: number;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export type GlobalId =
  | { kind: 'repo'; owner: string; name: string }
  | { kind: 'issue'; owner: string; repo: string; number: number }
  | { kind: 'pr'; owner: string; repo: string; number: number }
  | { kind: 'comment'; owner: string; repo: string; issue: number; id: number };

export class Store {
  readonly viewer: ScenarioUser;
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  /** The logical clock: every timestamp is the scenario epoch plus this counter. */
  private seq = 0;

  constructor() {
    this.viewer = viewerUser();
  }

  /** One logical tick: the next timestamp, as epoch seconds and ISO string. */
  tick(): { epochSec: number; iso: string } {
    this.seq += 1;
    const epochSec = SCENARIO_EPOCH_SEC + this.seq;
    return { epochSec, iso: new Date(epochSec * 1000).toISOString() };
  }

  private newId(): number {
    return this.nextId++;
  }

  // ---------------------------------------------------------------- global ids

  repoGlobalId(repo: Repo): string {
    return b64(`repo:${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return b64(`issue:${repo.owner}/${repo.name}/${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return b64(`pr:${repo.owner}/${repo.name}/${pull.number}`);
  }

  commentGlobalId(repo: Repo, issueNumber: number, comment: IssueComment): string {
    return b64(`comment:${repo.owner}/${repo.name}/${issueNumber}/${comment.id}`);
  }

  decodeGlobalId(id: string): GlobalId | null {
    const text = b64decode(id);
    if (text === null) return null;
    const parts = text.split(':');
    if (parts.length !== 2) return null;
    const [kind, rest] = parts as [string, string];
    if (kind === 'repo') {
      const [owner, name] = rest.split('/');
      if (owner && name) return { kind: 'repo', owner, name };
    } else if (kind === 'issue') {
      const [owner, repo, number] = rest.split('/');
      const n = Number(number);
      if (owner && repo && Number.isInteger(n)) return { kind: 'issue', owner, repo, number: n };
    } else if (kind === 'pr') {
      const [owner, repo, number] = rest.split('/');
      const n = Number(number);
      if (owner && repo && Number.isInteger(n)) return { kind: 'pr', owner, repo, number: n };
    } else if (kind === 'comment') {
      const [owner, repo, issue, cid] = rest.split('/');
      const i = Number(issue);
      const c = Number(cid);
      if (owner && repo && Number.isInteger(i) && Number.isInteger(c)) {
        return { kind: 'comment', owner, repo, issue: i, id: c };
      }
    }
    return null;
  }

  cursorFor(number: number): string {
    return b64(`cursor:${number}`);
  }

  cursorNumber(cursor: string | null | undefined): number | null {
    if (typeof cursor !== 'string' || cursor === '') return null;
    const text = b64decode(cursor);
    if (text === null || !text.startsWith('cursor:')) return null;
    const n = Number(text.slice(7));
    return Number.isInteger(n) ? n : null;
  }

  // ---------------------------------------------------------------- repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (name === '' || this.repos.has(this.repoKey(this.viewer.login, name))) return null;
    const { iso } = this.tick();
    const repo: Repo = {
      id: this.newId(),
      name,
      owner: this.viewer.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: iso,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      nextIssue: 1,
      pulls: [],
      nextPull: 1,
      comments: new Map(),
      nextCommentId: 1,
      treeCache: new Map(),
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  // ---------------------------------------------------------------- git objects

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, a full ref, or a commit oid to a commit oid. */
  resolveCommit(repo: Repo, ref: string): string | undefined {
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      if (oid === undefined) return undefined;
      return this.peelToCommit(repo, oid);
    }
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return this.peelToCommit(repo, branch);
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
    if (object !== undefined && object.type === 'tag') return this.peelToCommit(repo, ref);
    return undefined;
  }

  peelToCommit(repo: Repo, oid: string): string | undefined {
    const object = repo.objects.get(oid);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') return peelTag(repo.objects, oid) ?? undefined;
    return undefined;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  /** The flattened file map of a tree: path -> {oid, mode}. Cached; trees are immutable. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const cached = repo.treeCache.get(treeOid);
    if (cached !== undefined) return cached;
    const flat = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else flat.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    repo.treeCache.set(treeOid, flat);
    return flat;
  }

  /** Build (and store) the tree objects for a flattened file map; returns the root tree oid. */
  rebuildTree(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i]!;
        let child = node.dirs.get(part);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      const data = buildTree(entries);
      const oid = hashObject('tree', data);
      repo.objects.set(oid, { type: 'tree', data });
      return oid;
    };
    return build(root);
  }

  /** Commit `changes` (path -> bytes, null deletes) on `branch`; returns the new commit. */
  commitOnBranch(
    repo: Repo,
    branch: string,
    message: string,
    changes: Map<string, Buffer | null>,
  ): { commitSha: string; treeSha: string; contentShas: Map<string, string> } {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const baseTree = tip === undefined ? EMPTY_TREE_OID : parseCommit(repo.objects.get(tip)!.data).tree;
    const flat = new Map(this.flattenTree(repo, baseTree));
    const contentShas = new Map<string, string>();
    for (const [path, content] of changes) {
      if (content === null) {
        flat.delete(path);
        continue;
      }
      const blobOid = hashObject('blob', content);
      repo.objects.set(blobOid, { type: 'blob', data: Buffer.from(content) });
      flat.set(path, { oid: blobOid, mode: '100644' });
      contentShas.set(path, blobOid);
    }
    const treeSha = this.rebuildTree(repo, flat);
    const { epochSec } = this.tick();
    const ident = `${FORGE_IDENT_NAME} <${FORGE_IDENT_EMAIL}> ${epochSec} +0000`;
    const commit = buildCommit({
      tree: treeSha,
      parents: tip === undefined ? [] : [tip],
      author: ident,
      committer: ident,
      message,
    });
    const commitSha = hashObject('commit', commit);
    repo.objects.set(commitSha, { type: 'commit', data: commit });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, treeSha, contentShas };
  }

  /** The commit ancestry of a tip, newest first. */
  history(repo: Repo, tip: string): string[] {
    return commitHistory(tip, this.lookup(repo));
  }

  /** The reachable set of a set of tips (optionally depth-limited on commits). */
  reachable(repo: Repo, tips: Iterable<string>, maxDepth?: number): Set<string> {
    return collectReachable(tips, this.lookup(repo), maxDepth === undefined ? {} : { maxDepth }).seen;
  }

  /** True when `ancestor` is an ancestor of (or equal to) `tip`. */
  isFastForward(repo: Repo, ancestor: string, tip: string): boolean {
    return isAncestor(ancestor, tip, this.lookup(repo));
  }

  /** List a tree by oid, optionally recursively (paths are repo-relative). */
  listTreeRecursive(
    repo: Repo,
    oid: string,
    recursive: boolean,
  ): Array<{ path: string; mode: string; type: string; sha: string; size?: number }> | undefined {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return undefined;
    const walk = (treeOid: string, prefix: string): Array<{ path: string; mode: string; type: string; sha: string; size?: number }> => {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return [];
      const out: Array<{ path: string; mode: string; type: string; sha: string; size?: number }> = [];
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') {
          out.push({ path, mode: entry.mode, type: 'tree', sha: entry.oid });
          if (recursive) out.push(...walk(entry.oid, path));
        } else if (entry.mode === '160000') {
          out.push({ path, mode: entry.mode, type: 'commit', sha: entry.oid });
        } else {
          const blob = repo.objects.get(entry.oid);
          out.push({ path, mode: entry.mode, type: 'blob', sha: entry.oid, size: blob?.data.length });
        }
      }
      return out;
    };
    return walk(oid, '');
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const { iso } = this.tick();
    const issue: Issue = {
      id: this.newId(),
      number: repo.nextIssue++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: this.viewer.login,
      createdAt: iso,
      updatedAt: iso,
    };
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: Repo, options: { state?: string; sort?: string; direction?: string }): Issue[] {
    const state = options.state ?? 'open';
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const direction = options.direction ?? 'desc';
    if ((options.sort ?? 'created') === 'created') {
      list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    }
    return list;
  }

  createComment(repo: Repo, issueNumber: number, body: string): IssueComment | null {
    const issue = this.findIssue(repo, issueNumber);
    if (issue === undefined) return null;
    const { iso } = this.tick();
    const comment: IssueComment = { id: repo.nextCommentId++, body, user: this.viewer.login, createdAt: iso };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): IssueComment[] {
    return repo.comments.get(issueNumber) ?? [];
  }

  // ---------------------------------------------------------------- pull requests

  /** The files changed between two trees, with line counts from a multiset line diff. */
  diffTrees(repo: Repo, baseTree: string, headTree: string): DiffFile[] {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: DiffFile[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      const lineCounts = (oid: string | null): Map<string, number> => {
        const counts = new Map<string, number>();
        if (oid === null) return counts;
        const object = repo.objects.get(oid);
        if (object === undefined) return counts;
        const text = object.data.toString('utf8');
        const lines = text.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
        return counts;
      };
      const oldLines = lineCounts(b?.oid ?? null);
      const newLines = lineCounts(h?.oid ?? null);
      let additions = 0;
      let deletions = 0;
      for (const [line, count] of newLines) {
        const old = oldLines.get(line) ?? 0;
        if (count > old) additions += count - old;
      }
      for (const [line, count] of oldLines) {
        const next = newLines.get(line) ?? 0;
        if (count > next) deletions += count - next;
      }
      const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
      out.push({
        path,
        status,
        oldOid: b?.oid ?? null,
        newOid: h?.oid ?? null,
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return out;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined) return { error: `head branch ${head} does not exist` };
    if (baseTip === undefined) return { error: `base branch ${base} does not exist` };
    const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (existing !== undefined) return { error: `a pull request already exists for ${head}` };
    const { iso } = this.tick();
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const pull: Pull = {
      id: this.newId(),
      number: repo.nextPull++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      baseTreeAtCreation: baseTree,
      headTreeAtCreation: headTree,
      user: this.viewer.login,
      createdAt: iso,
      updatedAt: iso,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state: string): Pull[] {
    const want = state ?? 'open';
    return repo.pulls.filter((pull) => want === 'all' || pull.state === want);
  }

  pullFiles(repo: Repo, pull: Pull): DiffFile[] {
    return this.diffTrees(repo, pull.baseTreeAtCreation, pull.headTreeAtCreation);
  }

  /** True when the pull request cannot merge cleanly onto the base's current tip. */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const currentTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (currentTip === undefined) return true;
    const currentTree = parseCommit(repo.objects.get(currentTip)!.data).tree;
    const current = this.flattenTree(repo, currentTree);
    const base = this.flattenTree(repo, pull.baseTreeAtCreation);
    const head = this.flattenTree(repo, pull.headTreeAtCreation);
    for (const file of this.pullFiles(repo, pull)) {
      const atBase = base.get(file.path)?.oid ?? null;
      const atHead = head.get(file.path)?.oid ?? null;
      const atCurrent = current.get(file.path)?.oid ?? null;
      if (atCurrent !== atBase && atCurrent !== atHead) return true;
    }
    return false;
  }

  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge an open pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull): { sha: string; message: string } | { error: string; status: number } {
    if (pull.state !== 'open' || pull.merged) return { error: 'pull request is not open', status: 405 };
    if (this.pullConflicts(repo, pull)) return { error: 'merge conflict', status: 405 };
    const currentTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (currentTip === undefined) return { error: 'base branch does not exist', status: 404 };
    const currentTree = parseCommit(repo.objects.get(currentTip)!.data).tree;
    const flat = new Map(this.flattenTree(repo, currentTree));
    const head = this.flattenTree(repo, pull.headTreeAtCreation);
    for (const file of this.pullFiles(repo, pull)) {
      if (file.newOid === null) flat.delete(file.path);
      else flat.set(file.path, { oid: file.newOid, mode: head.get(file.path)?.mode ?? '100644' });
    }
    const treeSha = this.rebuildTree(repo, flat);
    const { epochSec, iso } = this.tick();
    const ident = `${FORGE_IDENT_NAME} <${FORGE_IDENT_EMAIL}> ${epochSec} +0000`;
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const commit = buildCommit({
      tree: treeSha,
      parents: [currentTip],
      author: ident,
      committer: ident,
      message,
    });
    const sha = hashObject('commit', commit);
    repo.objects.set(sha, { type: 'commit', data: commit });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = iso;
    pull.mergeCommitSha = sha;
    pull.updatedAt = iso;
    return { sha, message };
  }
}

// Re-exported for callers that only need the zero oid.
export { ZERO_OID };
