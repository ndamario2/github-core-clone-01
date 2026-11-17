// gitproto.ts — the git smart-HTTP surface: info/refs (v0 + v2), upload-pack
// (v2 ls-refs/fetch, v0 fallback) and receive-pack (v0). Every object is served
// from the store's own object map; every pack written is plain objects, version 2,
// with a SHA-1 trailer; every update is fast-forward only, per ref.

import {
  FLUSH,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  peelTag,
  pktLine,
  readPack,
  sidebandPack,
  sidebandPacket,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { Store, type Repo } from './store.ts';

const AGENT = 'github-core-clone-forge/1.0.0';
const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow object-format=sha1 agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status report-status-v2 delete-refs side-band-64k ofs-delta object-format=sha1 agent=${AGENT}`;

export interface GitAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

function textAnswer(status: number, message: string): GitAnswer {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The v0 ref advertisement lines (HEAD first, then refs, then peeled tags). */
function v0RefLines(repo: Repo, caps: string): string[] {
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    return lines;
  }
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? repo.refs.get('refs/heads/main');
  lines.push(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`);
  for (const ref of refs) lines.push(`${ref.oid} ${ref.name}\n`);
  for (const ref of refs) {
    if (!ref.name.startsWith('refs/tags/')) continue;
    const peeled = peelTag(repo.objects, ref.oid);
    if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
  }
  return lines;
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, isV2: boolean): GitAnswer {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return textAnswer(404, 'Not Found');
  if (service === 'git-upload-pack') {
    if (isV2) {
      const body = encodePktLines([
        'version 2\n',
        'ls-refs=unborn\n',
        'fetch=shallow\n',
        'object-format=sha1\n',
        `agent=${AGENT}\n`,
        'flush',
      ]);
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
    }
    // The v0 advertisement is the `# service=` line, a flush packet, then the
    // ref lines and a final flush. Real git's check_smart_http consumes
    // packets up to the first flush as the header; without that flush it
    // swallows the ref lines and reports no refs at all.
    const body = Buffer.concat([
      pktLine('# service=git-upload-pack\n'),
      FLUSH,
      encodePktLines([...v0RefLines(repo, UPLOAD_V0_CAPS), 'flush']),
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  if (service === 'git-receive-pack') {
    const body = Buffer.concat([
      pktLine('# service=git-receive-pack\n'),
      FLUSH,
      encodePktLines([...v0RefLines(repo, RECEIVE_V0_CAPS), 'flush']),
    ]);
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body };
  }
  return textAnswer(400, 'unknown service');
}

// ---------------------------------------------------------------------------
// pkt-line scanning of a request body
// ---------------------------------------------------------------------------

interface ScannedBody {
  /** Data pkt-line payloads, in order, up to the first flush (exclusive). */
  lines: string[];
  /** The bytes after the first flush packet (the pack, for receive-pack). */
  rest: Buffer;
}

/** Scan pkt-lines until the first flush; throws on a malformed length. */
function scanPktLines(body: Buffer): ScannedBody {
  const lines: string[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('pkt-line truncated');
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('pkt-line has no hex length');
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length === 1) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('pkt-line length out of range');
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { lines, rest: body.subarray(offset) };
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) req.depth = n;
    }
  }
  return req;
}

interface FetchPlan {
  /** Objects to send, in pack order. */
  send: GitObject[];
  /** The new shallow boundary commits. */
  shallow: string[];
  /** Old boundaries that are no longer shallow. */
  unshallow: string[];
  /** Haves the server acknowledges. */
  acks: string[];
}

/**
 * The object set a fetch delivers: reachable from the wants within the depth
 * limit, minus what the client already holds. A have's closure stops at the
 * client's current shallow boundaries (their parents are not held). The
 * shallow boundary is the included commits whose parents were not included;
 * an old boundary whose parents are now included is unshallowed.
 */
function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const maxDepth = req.depth === null ? undefined : req.depth;
  const wanted = collectReachable(req.wants, lookup, maxDepth === undefined ? {} : { maxDepth });
  const oldBoundaries = new Set(req.shallow.filter((oid) => isObjectId(oid)));
  // Held: the haves' closure, truncated at the old shallow boundaries (a boundary
  // commit's parents are not held).
  const held = collectReachable(req.haves, lookup, { stopAt: oldBoundaries }).seen;
  const send: GitObject[] = [];
  for (const oid of wanted.seen) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) send.push(object);
  }
  // Boundary: an included commit whose parents were not all included, or a root
  // commit at the depth cutoff.
  const shallow: string[] = [];
  if (maxDepth !== undefined) {
    for (const [oid, depth] of wanted.commits) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const parentMissing = parents.some((parent) => !wanted.seen.has(parent));
      const rootAtCutoff = parents.length === 0 && depth === maxDepth - 1;
      if (parentMissing || rootAtCutoff) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  if (maxDepth !== undefined) {
    for (const boundary of oldBoundaries) {
      if (!wanted.seen.has(boundary)) continue;
      if (shallow.includes(boundary)) continue;
      unshallow.push(boundary);
    }
  }
  // Acknowledgements: haves that are ancestors of (or equal to) a want.
  const fullWanted = collectReachable(req.wants, lookup, {}).seen;
  const acks = req.haves.filter((have) => repo.objects.has(have) && fullWanted.has(have));
  return { send, shallow, unshallow, acks };
}

function lsRefsResponse(repo: Repo, lines: string[]): GitAnswer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'command=ls-refs') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === '') continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const out: string[] = [];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // HEAD is a ref named "HEAD": a ref-prefix filter matches it when the
  // prefix is a prefix of "HEAD" (git's clone sends `ref-prefix HEAD`).
  const wantHead = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (wantHead) {
    if (headTip !== undefined) {
      out.push(`${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    } else if (unborn) {
      out.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  }
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelTag(repo.objects, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    out.push(`${line}\n`);
  }
  const body = encodePktLines([...out, 'flush']);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function fetchV2Response(repo: Repo, req: FetchRequest): GitAnswer {
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  // Protocol v2 sends the acknowledgments section only when the client sent
  // have lines; a fresh clone sends none, and real git then expects the
  // packfile (or shallow-info) section first.
  if (req.haves.length > 0) {
    const ackLines: string[] = [];
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) ackLines.push(`ACK ${ack}\n`);
      ackLines.push('ready\n');
    } else {
      ackLines.push('NAK\n');
    }
    parts.push(encodePktLines(['acknowledgments\n', ...ackLines, 'delim']));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: string[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines([...lines, 'delim']));
  }
  if (plan.send.length > 0) {
    const pack = writePack(plan.send);
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPack(pack)) parts.push(packet);
  }
  parts.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0Response(repo: Repo, req: FetchRequest): GitAnswer {
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.send.length > 0) {
    const pack = writePack(plan.send);
    for (const packet of sidebandPack(pack)) parts.push(packet);
  }
  parts.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, isV2: boolean): GitAnswer {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return textAnswer(404, 'Not Found');
  let scanned: ScannedBody;
  try {
    scanned = scanPktLines(body);
  } catch {
    return textAnswer(400, 'malformed pkt-line');
  }
  const first = (scanned.lines[0] ?? '').replace(/\n$/, '');
  if (isV2) {
    if (first === 'command=ls-refs') return lsRefsResponse(repo, scanned.lines);
    if (first === 'command=fetch') {
      const args = scanned.lines.filter((line) => !line.startsWith('command=') && !line.startsWith('agent=') && !line.startsWith('object-format=') && line !== '');
      return fetchV2Response(repo, parseFetchArgs(args));
    }
    return textAnswer(400, 'unknown v2 command');
  }
  // v0: want/have/shallow/deepen/done lines, in two flush-separated sections.
  // The body scan already stopped at the first flush; re-scan the whole body for
  // the second section's have lines.
  let allLines: string[];
  try {
    allLines = decodePktLines(body)
      .filter((packet) => packet.kind === 'data')
      .map((packet) => packet.payload.toString('utf8'));
  } catch {
    return textAnswer(400, 'malformed pkt-line');
  }
  return fetchV0Response(repo, parseFetchArgs(allLines));
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitAnswer {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return textAnswer(404, 'Not Found');
  let scanned: ScannedBody;
  try {
    scanned = scanPktLines(body);
  } catch {
    return textAnswer(400, 'malformed pkt-line');
  }
  const commands: PushCommand[] = [];
  for (const raw of scanned.lines) {
    const line = raw.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul === -1 ? line : line.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isObjectId(oldOid) && isObjectId(newOid) && ref.startsWith('refs/')) {
      commands.push({ oldOid, newOid, ref });
    }
  }
  if (commands.length === 0) return textAnswer(400, 'no push commands');
  const reportLines: string[] = [];
  const packBytes = scanned.rest;
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  if (!unpackOk) {
    for (const command of commands) reportLines.push(`ng ${command.ref} ${unpackDetail}\n`);
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        } else if (!repo.objects.has(command.newOid)) {
          reportLines.push(`ng ${command.ref} object not found\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else if (command.newOid === current) {
        reportLines.push(`ok ${command.ref}\n`);
      } else if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} object not found\n`);
      } else if (!isAncestor(current, command.newOid, (oid) => repo.objects.get(oid))) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
  }
  // The report-status stream is itself pkt-lined inside band 1 and ends with
  // its own flush packet; without it real git waits for more report and
  // reports "the remote end hung up unexpectedly".
  const inner = encodePktLines([`unpack ${unpackDetail}\n`, ...reportLines, 'flush']);
  const bodyOut = Buffer.concat([sidebandPacket(1, inner), FLUSH]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}
