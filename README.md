# github-core-clone-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ndamario2/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ndamario2/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 program, standard library only:
no git binary, no outside service, no proxy. One process serves four surfaces
over a single in-memory, deterministic store — replay the same requests and the
state comes out byte for byte identical, because the store runs on a logical
clock and never reads the wall clock or a random source.

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (capability advertisement, `ls-refs`, `fetch`, shallow and deepen) with a v0
  fallback, and receive-pack v0 (`report-status`, `side-band-64k`,
  `delete-refs`). Packfiles are parsed and generated in-process (pack v2/v3,
  ofs-delta and ref-delta resolution, thin packs). Every update is
  fast-forward only, per ref: a non-fast-forward push is refused with
  `ng <ref> non-fast-forward` and the ref does not move.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments, pull requests, squash merges, and the git refs
  endpoints. JSON always, a non-empty `X-GitHub-Request-Id` on every reply,
  bearer auth from `MAKEFUN_SHOP_TOKEN`.
- **GraphQL** at `/api/graphql` — repositories, issues and pull requests with
  cursor pagination and `orderBy`, `node()`, `search`, the five mutations, and
  full introspection (`__type` / `__schema`).
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, both the modern
  `server/discover` revision and the legacy `initialize` handshake, with six
  tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as
  REST.

## Run

```sh
node --experimental-strip-types main.ts
```

With no `MAKEFUN_ENV_URL` set the forge serves forever on `PORT` (or an
ephemeral port). In the trial pod it binds an ephemeral port, registers it
with `$MAKEFUN_ENV_URL/register`, serves the suite, and exits 0 once
`GET $MAKEFUN_ENV_URL/done` reports `{"done": true}`.

`MAKEFUN_SHOP_TOKEN` is the bearer token. The token's owner is the viewer:
every repository belongs to that login, and the same repository name under
another owner answers 404, never 403.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entrypoint: trial lifecycle and local-dev mode. |
| `app.ts` | HTTP front door: routing, auth, request ids. |
| `store.ts` | The deterministic in-memory store: repos, issues, PRs, objects, refs. |
| `gitobj.ts` | Git object layer: hashing, commits, trees, tags, pkt-lines, packs. |
| `gitproto.ts` | Smart HTTP: info/refs, upload-pack v2/v0, receive-pack v0. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL lexer, parser, executor, and introspection. |
| `mcp.ts` | MCP JSON-RPC handlers and the six tools. |
| `scenario.ts` | The deterministic scenario: users and the viewer identity. |

## Try it

```sh
export MAKEFUN_SHOP_TOKEN=test-token
node --experimental-strip-types main.ts &
curl -s -H "Authorization: Bearer test-token" http://127.0.0.1:$PORT/api/v3/user
curl -s -X POST -H "Authorization: Bearer test-token" -H 'Content-Type: application/json' \
  -d '{"name":"demo"}' http://127.0.0.1:$PORT/api/v3/user/repos
git clone http://127.0.0.1:$PORT/adaiversen/demo.git
```
