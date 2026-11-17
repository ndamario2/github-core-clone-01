// graphql.ts — a small GraphQL engine for the forge: lexer, recursive-descent
// parser, executor, and introspection, all over the shared store. It covers the
// operations the suite sends: repository/issue/pullRequest reads with cursor
// pagination and orderBy, node(), search, the five mutations, batching (a JSON
// array body answers with an array, in order), and __type/__schema.

import { Store, type Issue, type IssueComment, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type TokenKind = 'NAME' | 'INT' | 'FLOAT' | 'STRING' | 'PUNCT' | 'EOF';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\uFEFF') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      // Block string """...""" or a plain "..." string.
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        const value = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        tokens.push({ kind: 'STRING', value: value.replace(/\\"""/g, '"""') });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'STRING', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'FLOAT' : 'INT', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j]!)) j += 1;
      tokens.push({ kind: 'NAME', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('!$():=@[]{ }|&'.includes(c) || c === '.') {
      if (c === '.' && src.startsWith('...', i)) {
        tokens.push({ kind: 'PUNCT', value: '...' });
        i += 3;
        continue;
      }
      tokens.push({ kind: 'PUNCT', value: c });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface DirectiveNode {
  name: string;
  args: Record<string, ValueNode>;
}

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  directives: DirectiveNode[];
  selectionSet?: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface VariableDefinition {
  name: string;
  type: string;
  defaultValue?: ValueNode;
}

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: VariableDefinition[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  definitions: Array<OperationNode | FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'PUNCT' || token.value !== value) throw new Error(`expected "${value}" but got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'NAME') throw new Error(`expected a name but got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}" but got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const definitions: Array<OperationNode | FragmentNode> = [];
    while (this.peek().kind !== 'EOF') {
      definitions.push(this.parseDefinition());
    }
    return { definitions };
  }

  private parseDefinition(): OperationNode | FragmentNode {
    const token = this.peek();
    if (token.kind === 'PUNCT' && token.value === '{') {
      return { kind: 'operation', operation: 'query', variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'NAME' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      if (this.peek().kind === 'NAME') name = this.next().value;
      const variableDefinitions = this.parseVariableDefinitions();
      this.parseDirectives();
      return { kind: 'operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'NAME' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token ${token.value} at document level`);
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const defs: VariableDefinition[] = [];
    if (this.peek().kind === 'PUNCT' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'PUNCT' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'PUNCT' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        defs.push({ name, type, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): string {
    const token = this.peek();
    if (token.kind === 'PUNCT' && token.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      return this.parseNonNull(`[${inner}]`);
    }
    const name = this.expectName();
    return this.parseNonNull(name);
  }

  private parseNonNull(base: string): string {
    if (this.peek().kind === 'PUNCT' && this.peek().value === '!') {
      this.next();
      return `${base}!`;
    }
    return base;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'PUNCT' && this.peek().value === '@') {
      this.next();
      const name = this.expectName();
      const args = this.parseArguments();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'PUNCT' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'PUNCT' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args[name] = this.parseValue();
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'PUNCT' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'PUNCT' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'NAME' && next.value !== 'on') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      let typeCondition: string | undefined;
      if (next.kind === 'NAME' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'PUNCT' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'PUNCT' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'PUNCT' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'PUNCT' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'PUNCT' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'PUNCT' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'PUNCT' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'STRING') return { kind: 'string', value: token.value };
    if (token.kind === 'INT') return { kind: 'int', value: token.value };
    if (token.kind === 'FLOAT') return { kind: 'float', value: token.value };
    if (token.kind === 'NAME') {
      if (token.value === 'true' || token.value === 'false') return { kind: 'boolean', value: token.value };
      if (token.value === 'null') return { kind: 'null', value: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// type references and the schema
// ---------------------------------------------------------------------------

type TypeRef =
  | { kind: 'NAMED'; name: string }
  | { kind: 'LIST'; ofType: TypeRef }
  | { kind: 'NON_NULL'; ofType: TypeRef };

function parseTypeRef(text: string): TypeRef {
  const trimmed = text.trim();
  if (trimmed.endsWith('!')) return { kind: 'NON_NULL', ofType: parseTypeRef(trimmed.slice(0, -1)) };
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return { kind: 'LIST', ofType: parseTypeRef(trimmed.slice(1, -1)) };
  return { kind: 'NAMED', name: trimmed };
}

function namedType(ref: TypeRef): string {
  return ref.kind === 'NAMED' ? ref.name : namedType(ref.ofType);
}

interface ArgDef {
  name: string;
  type: string;
  defaultValue?: string;
}

interface FieldDef {
  name: string;
  type: string;
  args?: ArgDef[];
  description?: string;
}

interface TypeDef {
  name: string;
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT' | 'INTERFACE';
  description?: string;
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: ArgDef[];
  interfaces?: string[];
}

const SCALARS = ['String', 'Int', 'Float', 'Boolean', 'ID'];

function objectType(name: string, fields: FieldDef[], interfaces?: string[]): TypeDef {
  return { name, kind: 'OBJECT', fields, interfaces };
}

function enumType(name: string, values: string[]): TypeDef {
  return { name, kind: 'ENUM', enumValues: values };
}

function inputType(name: string, fields: ArgDef[]): TypeDef {
  return { name, kind: 'INPUT_OBJECT', inputFields: fields };
}

const SCHEMA: Record<string, TypeDef> = {};
function define(def: TypeDef): void {
  SCHEMA[def.name] = def;
}

define(objectType('Query', [
  { name: 'viewer', type: 'Viewer!' },
  { name: 'repository', type: 'Repository', args: [{ name: 'owner', type: 'String!' }, { name: 'name', type: 'String!' }] },
  { name: 'node', type: 'Node', args: [{ name: 'id', type: 'ID!' }] },
  {
    name: 'search',
    type: 'SearchResultItemConnection!',
    args: [
      { name: 'query', type: 'String!' },
      { name: 'type', type: 'SearchType!' },
      { name: 'first', type: 'Int' },
      { name: 'after', type: 'String' },
    ],
  },
  { name: '__schema', type: '__Schema!' },
  { name: '__type', type: '__Type', args: [{ name: 'name', type: 'String!' }] },
]));

define(objectType('Mutation', [
  { name: 'createIssue', type: 'CreateIssuePayload', args: [{ name: 'input', type: 'CreateIssueInput!' }] },
  { name: 'closeIssue', type: 'CloseIssuePayload', args: [{ name: 'input', type: 'CloseIssueInput!' }] },
  { name: 'createPullRequest', type: 'CreatePullRequestPayload', args: [{ name: 'input', type: 'CreatePullRequestInput!' }] },
  { name: 'mergePullRequest', type: 'MergePullRequestPayload', args: [{ name: 'input', type: 'MergePullRequestInput!' }] },
  { name: 'addComment', type: 'AddCommentPayload', args: [{ name: 'input', type: 'AddCommentInput!' }] },
]));

define(objectType('Viewer', [
  { name: 'login', type: 'String!' },
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'name', type: 'String' },
  { name: 'repositories', type: 'RepositoryConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
]));

define(objectType('User', [
  { name: 'login', type: 'String!' },
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'name', type: 'String' },
]));

define(objectType('Repository', [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'name', type: 'String!' },
  { name: 'nameWithOwner', type: 'String!' },
  { name: 'owner', type: 'User!' },
  { name: 'description', type: 'String' },
  { name: 'defaultBranchRef', type: 'Ref' },
  { name: 'viewerPermission', type: 'RepositoryPermission' },
  { name: 'hasIssuesEnabled', type: 'Boolean!' },
  { name: 'isPrivate', type: 'Boolean!' },
  { name: 'createdAt', type: 'String' },
  { name: 'updatedAt', type: 'String' },
  { name: 'url', type: 'String' },
  { name: 'issue', type: 'Issue', args: [{ name: 'number', type: 'Int!' }] },
  {
    name: 'issues',
    type: 'IssueConnection!',
    args: [
      { name: 'first', type: 'Int' },
      { name: 'after', type: 'String' },
      { name: 'states', type: '[IssueState!]' },
      { name: 'orderBy', type: 'IssueOrder' },
    ],
  },
  { name: 'pullRequest', type: 'PullRequest', args: [{ name: 'number', type: 'Int!' }] },
  {
    name: 'pullRequests',
    type: 'PullRequestConnection!',
    args: [
      { name: 'first', type: 'Int' },
      { name: 'after', type: 'String' },
      { name: 'states', type: '[PullRequestState!]' },
      { name: 'orderBy', type: 'PullRequestOrder' },
    ],
  },
], ['Node']));

define(objectType('Ref', [
  { name: 'name', type: 'String!' },
  { name: 'prefix', type: 'String!' },
  { name: 'target', type: 'GitObject' },
]));

define(objectType('GitObject', [
  { name: 'oid', type: 'String!' },
]));

define(objectType('Issue', [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'number', type: 'Int!' },
  { name: 'title', type: 'String!' },
  { name: 'body', type: 'String!' },
  { name: 'state', type: 'IssueState!' },
  { name: 'createdAt', type: 'String' },
  { name: 'updatedAt', type: 'String' },
  { name: 'url', type: 'String' },
  { name: 'author', type: 'User' },
  { name: 'labels', type: 'LabelConnection', args: [{ name: 'first', type: 'Int' }] },
  { name: 'comments', type: 'IssueCommentConnection', args: [{ name: 'first', type: 'Int' }] },
  { name: 'repository', type: 'Repository!' },
], ['Node']));

define(objectType('IssueConnection', [
  { name: 'nodes', type: '[Issue]' },
  { name: 'edges', type: '[IssueEdge]' },
  { name: 'pageInfo', type: 'PageInfo!' },
  { name: 'totalCount', type: 'Int!' },
]));

define(objectType('IssueEdge', [
  { name: 'node', type: 'Issue' },
  { name: 'cursor', type: 'String!' },
]));

define(objectType('PullRequest', [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'number', type: 'Int!' },
  { name: 'title', type: 'String!' },
  { name: 'body', type: 'String!' },
  { name: 'state', type: 'PullRequestState!' },
  { name: 'headRefName', type: 'String!' },
  { name: 'baseRefName', type: 'String!' },
  { name: 'headRefOid', type: 'String' },
  { name: 'baseRefOid', type: 'String' },
  { name: 'mergeable', type: 'MergeableState!' },
  { name: 'merged', type: 'Boolean!' },
  { name: 'mergedAt', type: 'String' },
  { name: 'mergeCommit', type: 'GitObject' },
  { name: 'createdAt', type: 'String' },
  { name: 'updatedAt', type: 'String' },
  { name: 'author', type: 'User' },
  { name: 'files', type: 'PullRequestFileConnection', args: [{ name: 'first', type: 'Int' }] },
  { name: 'repository', type: 'Repository!' },
], ['Node']));

define(objectType('PullRequestConnection', [
  { name: 'nodes', type: '[PullRequest]' },
  { name: 'edges', type: '[PullRequestEdge]' },
  { name: 'pageInfo', type: 'PageInfo!' },
  { name: 'totalCount', type: 'Int!' },
]));

define(objectType('PullRequestEdge', [
  { name: 'node', type: 'PullRequest' },
  { name: 'cursor', type: 'String!' },
]));

define(objectType('PullRequestFileConnection', [
  { name: 'nodes', type: '[PullRequestChangedFile]' },
  { name: 'totalCount', type: 'Int!' },
]));

define(objectType('PullRequestChangedFile', [
  { name: 'path', type: 'String!' },
  { name: 'additions', type: 'Int!' },
  { name: 'deletions', type: 'Int!' },
  { name: 'status', type: 'String!' },
]));

define(objectType('Label', [
  { name: 'id', type: 'ID!' },
  { name: 'name', type: 'String!' },
  { name: 'color', type: 'String' },
  { name: 'description', type: 'String' },
]));

define(objectType('LabelConnection', [
  { name: 'nodes', type: '[Label]' },
  { name: 'totalCount', type: 'Int!' },
]));

define(objectType('Comment', [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'body', type: 'String!' },
  { name: 'createdAt', type: 'String' },
  { name: 'author', type: 'User' },
], ['Node']));

define(objectType('CommentEdge', [
  { name: 'node', type: 'Comment' },
  { name: 'cursor', type: 'String!' },
]));

define(objectType('IssueCommentConnection', [
  { name: 'nodes', type: '[Comment]' },
  { name: 'edges', type: '[CommentEdge]' },
  { name: 'totalCount', type: 'Int!' },
]));

define(objectType('PageInfo', [
  { name: 'hasNextPage', type: 'Boolean!' },
  { name: 'hasPreviousPage', type: 'Boolean!' },
  { name: 'startCursor', type: 'String' },
  { name: 'endCursor', type: 'String' },
]));

define(objectType('RepositoryConnection', [
  { name: 'nodes', type: '[Repository]' },
  { name: 'edges', type: '[RepositoryEdge]' },
  { name: 'pageInfo', type: 'PageInfo!' },
  { name: 'totalCount', type: 'Int!' },
]));

define(objectType('RepositoryEdge', [
  { name: 'node', type: 'Repository' },
  { name: 'cursor', type: 'String!' },
]));

define(objectType('SearchResultItemConnection', [
  { name: 'nodes', type: '[SearchResultItem]' },
  { name: 'edges', type: '[SearchResultItemEdge]' },
  { name: 'pageInfo', type: 'PageInfo!' },
  { name: 'totalCount', type: 'Int!' },
]));

define(objectType('SearchResultItemEdge', [
  { name: 'node', type: 'SearchResultItem' },
  { name: 'cursor', type: 'String!' },
]));

define({ name: 'Node', kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID!' }] });
define({ name: 'SearchResultItem', kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID!' }] });

define(objectType('CreateIssuePayload', [
  { name: 'issue', type: 'Issue' },
  { name: 'clientMutationId', type: 'String' },
]));
define(objectType('CloseIssuePayload', [
  { name: 'issue', type: 'Issue' },
  { name: 'clientMutationId', type: 'String' },
]));
define(objectType('CreatePullRequestPayload', [
  { name: 'pullRequest', type: 'PullRequest' },
  { name: 'clientMutationId', type: 'String' },
]));
define(objectType('MergePullRequestPayload', [
  { name: 'pullRequest', type: 'PullRequest' },
  { name: 'clientMutationId', type: 'String' },
]));
define(objectType('AddCommentPayload', [
  { name: 'commentEdge', type: 'CommentEdge' },
  { name: 'subject', type: 'Node' },
  { name: 'clientMutationId', type: 'String' },
]));

define(enumType('IssueState', ['OPEN', 'CLOSED']));
define(enumType('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']));
define(enumType('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']));
define(enumType('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']));
define(enumType('SearchType', ['ISSUE', 'REPOSITORY', 'USER']));
define(enumType('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']));
define(enumType('OrderDirection', ['ASC', 'DESC']));
define(enumType('PullRequestOrderField', ['CREATED_AT', 'UPDATED_AT']));
define(enumType('RepositoryOrderField', ['CREATED_AT', 'UPDATED_AT', 'NAME', 'PUSHED_AT', 'STARGAZERS']));
define(enumType('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']));

define(inputType('IssueOrder', [
  { name: 'field', type: 'IssueOrderField!' },
  { name: 'direction', type: 'OrderDirection!' },
]));
define(inputType('PullRequestOrder', [
  { name: 'field', type: 'PullRequestOrderField!' },
  { name: 'direction', type: 'OrderDirection!' },
]));
define(inputType('CreateIssueInput', [
  { name: 'repositoryId', type: 'ID!' },
  { name: 'title', type: 'String!' },
  { name: 'body', type: 'String' },
  { name: 'clientMutationId', type: 'String' },
]));
define(inputType('CloseIssueInput', [
  { name: 'issueId', type: 'ID!' },
  { name: 'clientMutationId', type: 'String' },
]));
define(inputType('CreatePullRequestInput', [
  { name: 'repositoryId', type: 'ID!' },
  { name: 'baseRefName', type: 'String!' },
  { name: 'headRefName', type: 'String!' },
  { name: 'title', type: 'String!' },
  { name: 'body', type: 'String' },
  { name: 'clientMutationId', type: 'String' },
]));
define(inputType('MergePullRequestInput', [
  { name: 'pullRequestId', type: 'ID!' },
  { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
  { name: 'clientMutationId', type: 'String' },
]));
define(inputType('AddCommentInput', [
  { name: 'subjectId', type: 'ID!' },
  { name: 'body', type: 'String!' },
  { name: 'clientMutationId', type: 'String' },
]));

for (const scalar of SCALARS) define({ name: scalar, kind: 'SCALAR' });

define(objectType('__Schema', [
  { name: 'queryType', type: '__Type!' },
  { name: 'mutationType', type: '__Type' },
  { name: 'subscriptionType', type: '__Type' },
  { name: 'types', type: '[__Type!]!' },
  { name: 'directives', type: '[__Directive!]!' },
]));
define(objectType('__Type', [
  { name: 'name', type: 'String' },
  { name: 'kind', type: 'String' },
  { name: 'description', type: 'String' },
  { name: 'fields', type: '[__Field!]', args: [{ name: 'includeDeprecated', type: 'Boolean', defaultValue: 'false' }] },
  { name: 'interfaces', type: '[__Type!]' },
  { name: 'possibleTypes', type: '[__Type!]' },
  { name: 'enumValues', type: '[__EnumValue!]', args: [{ name: 'includeDeprecated', type: 'Boolean', defaultValue: 'false' }] },
  { name: 'inputFields', type: '[__InputValue!]' },
  { name: 'ofType', type: '__Type' },
]));
define(objectType('__Field', [
  { name: 'name', type: 'String!' },
  { name: 'description', type: 'String' },
  { name: 'args', type: '[__InputValue!]!' },
  { name: 'type', type: '__Type!' },
  { name: 'isDeprecated', type: 'Boolean!' },
  { name: 'deprecationReason', type: 'String' },
]));
define(objectType('__InputValue', [
  { name: 'name', type: 'String!' },
  { name: 'description', type: 'String' },
  { name: 'type', type: '__Type!' },
  { name: 'defaultValue', type: 'String' },
]));
define(objectType('__EnumValue', [
  { name: 'name', type: 'String!' },
  { name: 'description', type: 'String' },
  { name: 'isDeprecated', type: 'Boolean!' },
  { name: 'deprecationReason', type: 'String' },
]));
define(objectType('__Directive', [
  { name: 'name', type: 'String!' },
  { name: 'description', type: 'String' },
  { name: 'locations', type: '[String!]!' },
  { name: 'args', type: '[__InputValue!]!' },
]));

// ---------------------------------------------------------------------------
// runtime values (tagged with __typename)
// ---------------------------------------------------------------------------

type AnyValue = Record<string, unknown> & { __typename?: string };

function tag<T extends Record<string, unknown>>(typename: string, value: T): T & { __typename: string } {
  return { __typename: typename, ...value };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoValue(store: Store, repo: Repo): AnyValue {
  return tag('Repository', {
    __repo: repo,
    id: store.repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${store.viewer.login}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.createdAt,
    url: `/${store.viewer.login}/${repo.name}`,
  });
}

function issueValue(store: Store, repo: Repo, issue: Issue): AnyValue {
  return tag('Issue', {
    __repo: repo,
    __issue: issue,
    id: store.issueGlobalId(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `/${store.viewer.login}/${repo.name}/issues/${issue.number}`,
  });
}

function pullValue(store: Store, repo: Repo, pull: Pull): AnyValue {
  return tag('PullRequest', {
    __repo: repo,
    __pull: pull,
    id: store.pullGlobalId(repo, pull),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
  });
}

function commentValue(store: Store, repo: Repo, issueNumber: number, comment: IssueComment): AnyValue {
  return tag('Comment', {
    __repo: repo,
    id: store.commentGlobalId(repo, issueNumber, comment),
    databaseId: comment.id,
    body: comment.body,
    createdAt: comment.createdAt,
  });
}

function userValue(store: Store): AnyValue {
  return tag('User', {
    login: store.viewer.login,
    id: Buffer.from(`user:${store.viewer.login}`, 'utf8').toString('base64'),
    databaseId: store.viewer.id,
    name: store.viewer.name,
  });
}

/** Sort + slice a list of numbered items the way a connection does. */
function connectionPage<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
  order: (a: T, b: T) => number,
  store: Store,
): { nodes: T[]; pageInfo: Record<string, unknown>; totalCount: number } {
  const sorted = [...items].sort(order);
  const after = typeof args.after === 'string' ? store.cursorNumber(args.after) : null;
  let start = 0;
  if (after !== null) {
    const index = sorted.findIndex((item) => item.number === after);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : sorted.length;
  const nodes = sorted.slice(start, start + first);
  const endIndex = start + nodes.length;
  return {
    nodes,
    totalCount: sorted.length,
    pageInfo: {
      hasNextPage: endIndex < sorted.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? store.cursorFor(nodes[0]!.number) : null,
      endCursor: nodes.length > 0 ? store.cursorFor(nodes[nodes.length - 1]!.number) : null,
    },
  };
}

function issueOrder(args: Record<string, unknown>): (a: Issue, b: Issue) => number {
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = orderBy.field as string | undefined;
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  if (field === 'UPDATED_AT') return (a, b) => direction * (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number);
  if (field === 'COMMENTS') return (a, b) => direction * (a.number - b.number);
  // CREATED_AT (and the default): creation order is the issue number.
  return (a, b) => direction * (a.number - b.number);
}

function pullOrder(args: Record<string, unknown>): (a: Pull, b: Pull) => number {
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  if (orderBy.field === 'UPDATED_AT') return (a, b) => direction * (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number);
  return (a, b) => direction * (a.number - b.number);
}

// ---------------------------------------------------------------------------
// field resolvers
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentNode>;
}

type Resolver = (parent: AnyValue, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_parent, _args, ctx) => tag('Viewer', { login: ctx.store.viewer.login, id: Buffer.from(`user:${ctx.store.viewer.login}`, 'utf8').toString('base64'), databaseId: ctx.store.viewer.id, name: ctx.store.viewer.name }),
    repository: (_parent, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoValue(ctx.store, repo);
    },
    node: (_parent, args, ctx) => {
      const decoded = ctx.store.decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.kind === 'repo') {
        const repo = ctx.store.getRepo(decoded.owner, decoded.name);
        return repo === undefined ? null : repoValue(ctx.store, repo);
      }
      if (decoded.kind === 'issue') {
        const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
        if (repo === undefined) return null;
        const issue = ctx.store.findIssue(repo, decoded.number);
        return issue === undefined ? null : issueValue(ctx.store, repo, issue);
      }
      if (decoded.kind === 'pr') {
        const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
        if (repo === undefined) return null;
        const pull = ctx.store.findPull(repo, decoded.number);
        return pull === undefined ? null : pullValue(ctx.store, repo, pull);
      }
      if (decoded.kind === 'comment') {
        const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
        if (repo === undefined) return null;
        const comment = ctx.store.listComments(repo, decoded.issue).find((c) => c.id === decoded.id);
        return comment === undefined ? null : commentValue(ctx.store, repo, decoded.issue, comment);
      }
      return null;
    },
    search: (_parent, args, ctx) => {
      const needle = String(args.query ?? '').toLowerCase();
      const type = String(args.type ?? 'ISSUE');
      const nodes: AnyValue[] = [];
      if (type === 'ISSUE') {
        for (const repo of ctx.store.listRepos()) {
          for (const issue of ctx.store.listIssues(repo, { state: 'all' })) {
            if (issue.title.toLowerCase().includes(needle) || issue.body.toLowerCase().includes(needle)) {
              nodes.push(issueValue(ctx.store, repo, issue));
            }
          }
        }
      } else if (type === 'REPOSITORY') {
        for (const repo of ctx.store.listRepos()) {
          if (repo.name.toLowerCase().includes(needle)) nodes.push(repoValue(ctx.store, repo));
        }
      }
      const page = connectionPage(
        nodes.map((node, index) => ({ __node: node, number: index + 1 })),
        args,
        (a, b) => a.number - b.number,
        ctx.store,
      );
      const pageNodes = page.nodes.map((item) => item.__node);
      return tag('SearchResultItemConnection', {
        nodes: pageNodes,
        edges: pageNodes.map((node, i) => tag('SearchResultItemEdge', { node, cursor: ctx.store.cursorFor(page.nodes[i]!.number) })),
        pageInfo: page.pageInfo,
        totalCount: page.totalCount,
      });
    },
    __schema: () => tag('__Schema', {}),
    __type: (_parent, args) => {
      const def = SCHEMA[String(args.name ?? '')];
      return def === undefined ? null : typeRefShape(parseTypeRef(def.name));
    },
  },
  Viewer: {
    repositories: (_parent, args, ctx) => {
      const repos = ctx.store.listRepos().sort((a, b) => a.id - b.id);
      const page = connectionPage(
        repos.map((repo) => ({ __repo: repo, number: repo.id })),
        args,
        (a, b) => a.number - b.number,
        ctx.store,
      );
      const nodes = page.nodes.map((item) => repoValue(ctx.store, item.__repo));
      return tag('RepositoryConnection', {
        nodes,
        edges: nodes.map((node, i) => tag('RepositoryEdge', { node, cursor: ctx.store.cursorFor(page.nodes[i]!.number) })),
        pageInfo: page.pageInfo,
        totalCount: page.totalCount,
      });
    },
  },
  Repository: {
    owner: (_parent, _args, ctx) => userValue(ctx.store),
    defaultBranchRef: (parent, _args, ctx) => {
      const repo = parent.__repo as Repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return tag('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/', target: tag('GitObject', { oid: tip }) });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const issue = ctx.store.findIssue(repo, Number(args.number));
      return issue === undefined ? null : issueValue(ctx.store, repo, issue);
    },
    issues: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      let issues = ctx.store.listIssues(repo, { state: 'all' });
      const states = args.states as string[] | undefined;
      if (states !== undefined && states.length > 0) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const page = connectionPage(issues, args, issueOrder(args), ctx.store);
      const nodes = page.nodes.map((issue) => issueValue(ctx.store, repo, issue));
      return tag('IssueConnection', {
        nodes,
        edges: nodes.map((node, i) => tag('IssueEdge', { node, cursor: ctx.store.cursorFor(page.nodes[i]!.number) })),
        pageInfo: page.pageInfo,
        totalCount: page.totalCount,
      });
    },
    pullRequest: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const pull = ctx.store.findPull(repo, Number(args.number));
      return pull === undefined ? null : pullValue(ctx.store, repo, pull);
    },
    pullRequests: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      let pulls = ctx.store.listPulls(repo, 'all');
      const states = args.states as string[] | undefined;
      if (states !== undefined && states.length > 0) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : 'merged')));
        pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'merged' : pull.state));
      }
      const page = connectionPage(pulls, args, pullOrder(args), ctx.store);
      const nodes = page.nodes.map((pull) => pullValue(ctx.store, repo, pull));
      return tag('PullRequestConnection', {
        nodes,
        edges: nodes.map((node, i) => tag('PullRequestEdge', { node, cursor: ctx.store.cursorFor(page.nodes[i]!.number) })),
        pageInfo: page.pageInfo,
        totalCount: page.totalCount,
      });
    },
  },
  Issue: {
    author: (_parent, _args, ctx) => userValue(ctx.store),
    labels: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const issue = parent.__issue as Issue;
      const labels = issue.labels
        .map((name) => repo.labels.get(name))
        .filter((label): label is NonNullable<typeof label> => label !== undefined);
      const nodes = labels.map((label) => tag('Label', { id: Buffer.from(`label:${label.name}`, 'utf8').toString('base64'), name: label.name, color: label.color, description: label.description }));
      const first = typeof args.first === 'number' && args.first > 0 ? args.first : nodes.length;
      return tag('LabelConnection', { nodes: nodes.slice(0, first), totalCount: nodes.length });
    },
    comments: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const issue = parent.__issue as Issue;
      const comments = ctx.store.listComments(repo, issue.number).map((comment) => commentValue(ctx.store, repo, issue.number, comment));
      const first = typeof args.first === 'number' && args.first > 0 ? args.first : comments.length;
      const nodes = comments.slice(0, first);
      return tag('IssueCommentConnection', {
        nodes,
        edges: nodes.map((node, i) => tag('CommentEdge', { node, cursor: ctx.store.cursorFor(i + 1) })),
        totalCount: comments.length,
      });
    },
    repository: (parent, _args, ctx) => repoValue(ctx.store, parent.__repo as Repo),
  },
  PullRequest: {
    author: (_parent, _args, ctx) => userValue(ctx.store),
    mergeable: (parent, _args, ctx) => {
      const repo = parent.__repo as Repo;
      const pull = parent.__pull as Pull;
      return ctx.store.pullMergeable(repo, pull);
    },
    mergeCommit: (parent) => {
      const pull = parent.__pull as Pull;
      return pull.mergeCommitSha === null ? null : tag('GitObject', { oid: pull.mergeCommitSha });
    },
    files: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const pull = parent.__pull as Pull;
      const files = ctx.store.pullFiles(repo, pull);
      const first = typeof args.first === 'number' && args.first > 0 ? args.first : files.length;
      const nodes = files.slice(0, first).map((file) => tag('PullRequestChangedFile', { path: file.path, additions: file.additions, deletions: file.deletions, status: file.status }));
      return tag('PullRequestFileConnection', { nodes, totalCount: files.length });
    },
    repository: (parent, _args, ctx) => repoValue(ctx.store, parent.__repo as Repo),
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = ctx.store.decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'repo') throw new Error('repository not found');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) throw new Error('repository not found');
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return tag('CreateIssuePayload', { issue: issueValue(ctx.store, repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null });
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = ctx.store.decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'issue') throw new Error('issue not found');
      const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
      if (repo === undefined) throw new Error('issue not found');
      const issue = ctx.store.findIssue(repo, decoded.number);
      if (issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updatedAt = ctx.store.tick().iso;
      return tag('CloseIssuePayload', { issue: issueValue(ctx.store, repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null });
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = ctx.store.decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'repo') throw new Error('repository not found');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) throw new Error('repository not found');
      const result = ctx.store.createPull(
        repo,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in result) throw new Error(result.error);
      return tag('CreatePullRequestPayload', { pullRequest: pullValue(ctx.store, repo, result), clientMutationId: (input.clientMutationId as string | undefined) ?? null });
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = ctx.store.decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'pr') throw new Error('pull request not found');
      const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
      if (repo === undefined) throw new Error('pull request not found');
      const pull = ctx.store.findPull(repo, decoded.number);
      if (pull === undefined) throw new Error('pull request not found');
      const result = ctx.store.mergePull(repo, pull);
      if ('error' in result) throw new Error(result.error);
      return tag('MergePullRequestPayload', { pullRequest: pullValue(ctx.store, repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null });
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = ctx.store.decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null) throw new Error('subject not found');
      if (decoded.kind === 'repo') throw new Error('subject not found');
      const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
      if (repo === undefined) throw new Error('subject not found');
      let issueNumber = decoded.kind === 'comment' ? decoded.issue : decoded.number;
      if (decoded.kind === 'pr') {
        const issue = ctx.store.findIssue(repo, decoded.number);
        if (issue === undefined) throw new Error('subject not found');
        issueNumber = issue.number;
      }
      const comment = ctx.store.createComment(repo, issueNumber, String(input.body ?? ''));
      if (comment === null) throw new Error('subject not found');
      const subject = decoded.kind === 'pr'
        ? pullValue(ctx.store, repo, ctx.store.findPull(repo, issueNumber)!)
        : issueValue(ctx.store, repo, ctx.store.findIssue(repo, issueNumber)!);
      return tag('AddCommentPayload', {
        commentEdge: tag('CommentEdge', { node: commentValue(ctx.store, repo, issueNumber, comment), cursor: ctx.store.cursorFor(comment.id) }),
        subject,
        clientMutationId: (input.clientMutationId as string | undefined) ?? null,
      });
    },
  },
};

// ---------------------------------------------------------------------------
// introspection resolvers (over the schema data)
// ---------------------------------------------------------------------------

function typeRefShape(ref: TypeRef): AnyValue {
  if (ref.kind === 'NAMED') {
    const def = SCHEMA[ref.name];
    return tag('__Type', { __def: def, __ref: ref, name: ref.name, kind: def?.kind ?? 'SCALAR', description: def?.description ?? null });
  }
  const ofType = typeRefShape(ref.ofType);
  return tag('__Type', { __def: undefined, __ref: ref, name: null, kind: ref.kind === 'LIST' ? 'LIST' : 'NON_NULL', description: null, ofType });
}

function fieldShape(field: FieldDef): AnyValue {
  return tag('__Field', {
    name: field.name,
    description: field.description ?? null,
    args: (field.args ?? []).map((arg) => tag('__InputValue', { name: arg.name, description: null, type: typeRefShape(parseTypeRef(arg.type)), defaultValue: arg.defaultValue ?? null })),
    type: typeRefShape(parseTypeRef(field.type)),
    isDeprecated: false,
    deprecationReason: null,
  });
}

const INTROSPECTION: Record<string, Record<string, Resolver>> = {
  __Schema: {
    queryType: () => typeRefShape(parseTypeRef('Query')),
    mutationType: () => typeRefShape(parseTypeRef('Mutation')),
    subscriptionType: () => null,
    types: () => Object.values(SCHEMA).map((def) => tag('__Type', { __def: def, __ref: parseTypeRef(def.name), name: def.name, kind: def.kind, description: def.description ?? null })),
    directives: () => [
      tag('__Directive', { name: 'include', description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [tag('__InputValue', { name: 'if', description: null, type: typeRefShape(parseTypeRef('Boolean!')), defaultValue: null })] }),
      tag('__Directive', { name: 'skip', description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [tag('__InputValue', { name: 'if', description: null, type: typeRefShape(parseTypeRef('Boolean!')), defaultValue: null })] }),
    ],
  },
  __Type: {
    fields: (parent) => {
      const def = parent.__def as TypeDef | undefined;
      if (def === undefined || def.fields === undefined) return null;
      return def.fields.map(fieldShape);
    },
    interfaces: (parent) => {
      const def = parent.__def as TypeDef | undefined;
      if (def === undefined || def.interfaces === undefined) return [];
      return def.interfaces.map((name) => typeRefShape(parseTypeRef(name)));
    },
    possibleTypes: (parent) => {
      const def = parent.__def as TypeDef | undefined;
      if (def === undefined) return null;
      if (def.kind === 'INTERFACE') {
        return Object.values(SCHEMA)
          .filter((candidate) => candidate.interfaces?.includes(def.name))
          .map((candidate) => typeRefShape(parseTypeRef(candidate.name)));
      }
      return null;
    },
    enumValues: (parent) => {
      const def = parent.__def as TypeDef | undefined;
      if (def === undefined || def.enumValues === undefined) return null;
      return def.enumValues.map((name) => tag('__EnumValue', { name, description: null, isDeprecated: false, deprecationReason: null }));
    },
    inputFields: (parent) => {
      const def = parent.__def as TypeDef | undefined;
      if (def === undefined || def.inputFields === undefined) return null;
      return def.inputFields.map((arg) => tag('__InputValue', { name: arg.name, description: null, type: typeRefShape(parseTypeRef(arg.type)), defaultValue: arg.defaultValue ?? null }));
    },
    ofType: (parent) => {
      const ref = parent.__ref as TypeRef | undefined;
      if (ref === undefined || ref.kind === 'NAMED') return null;
      return typeRefShape(ref.ofType);
    },
  },
};

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

function evaluateValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
      return node.value;
    case 'int':
      return Number(node.value);
    case 'float':
      return Number(node.value);
    case 'boolean':
      return node.value === 'true';
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => evaluateValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = evaluateValue(child, variables);
      return out;
    }
  }
}

function evaluateArgs(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(field.args)) args[name] = evaluateValue(node, ctx.variables);
  return args;
}

function fieldDefFor(typeName: string, fieldName: string): FieldDef | undefined {
  const def = SCHEMA[typeName];
  return def?.fields?.find((field) => field.name === fieldName);
}

function completeValue(value: unknown, typeRef: TypeRef, selections: SelectionNode[] | undefined, ctx: Ctx): unknown {
  if (typeRef.kind === 'NON_NULL') {
    const completed = completeValue(value, typeRef.ofType, selections, ctx);
    if (completed === null || completed === undefined) {
      throw new Error('non-null field resolved to null');
    }
    return completed;
  }
  if (value === null || value === undefined) return null;
  if (typeRef.kind === 'LIST') {
    if (!Array.isArray(value)) throw new Error('expected a list');
    return value.map((item) => completeValue(item, typeRef.ofType, selections, ctx));
  }
  const name = typeRef.name;
  const def = SCHEMA[name];
  if (def === undefined) return value;
  if (def.kind === 'SCALAR') return value;
  if (def.kind === 'ENUM') return value;
  if (def.kind === 'INTERFACE') {
    // Resolve against the concrete type of the value.
    const concrete = (value as AnyValue).__typename;
    if (concrete === undefined) return value;
    if (selections === undefined) throw new Error(`field of type ${name} must have a sub selection`);
    return executeSelections(selections, concrete, value as AnyValue, ctx);
  }
  // Object type.
  if (selections === undefined) throw new Error(`field of type ${name} must have a sub selection`);
  return executeSelections(selections, name, value as AnyValue, ctx);
}

function executeSelections(selections: SelectionNode[], typeName: string, parent: AnyValue, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      const merged = executeSelections(fragment.selectionSet, typeName, parent, ctx);
      Object.assign(out, merged);
      continue;
    }
    if (selection.kind === 'inline') {
      const condition = selection.typeCondition;
      if (condition !== undefined && condition !== typeName) {
        const def = SCHEMA[condition];
        const isInterface = def?.kind === 'INTERFACE';
        if (!isInterface) continue;
        const concrete = SCHEMA[typeName];
        if (!concrete?.interfaces?.includes(condition)) continue;
      }
      const merged = executeSelections(selection.selectionSet, typeName, parent, ctx);
      Object.assign(out, merged);
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const def = fieldDefFor(typeName, field.name);
    if (def === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const args = evaluateArgs(field, ctx);
    const typeRef = parseTypeRef(def.type);
    let raw: unknown;
    try {
      const table = INTROSPECTION[typeName] ?? RESOLVERS[typeName];
      const resolver = table?.[field.name];
      if (resolver !== undefined) {
        raw = resolver(parent, args, ctx);
      } else {
        raw = parent[field.name];
      }
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[responseKey] = null;
      continue;
    }
    try {
      out[responseKey] = completeValue(raw, typeRef, field.selectionSet, ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[responseKey] = null;
    }
  }
  return out;
}

function executeOperation(store: Store, operation: OperationNode, document: DocumentNode, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { store, variables, errors: [], fragments: new Map() };
  for (const definition of document.definitions) {
    if (definition.kind === 'fragment') ctx.fragments.set(definition.name, definition);
  }
  // Variable defaults.
  for (const varDef of operation.variableDefinitions) {
    if (!(varDef.name in ctx.variables) && varDef.defaultValue !== undefined) {
      ctx.variables[varDef.name] = evaluateValue(varDef.defaultValue, ctx.variables);
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(operation.selectionSet, rootType, tag(rootType, {}), ctx);
  const result: { data: unknown; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export interface GraphQLResponse {
  status: number;
  body: string;
}

export function handleGraphQL(store: Store, body: Buffer, authed: boolean): GraphQLResponse {
  if (!authed) {
    return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'malformed JSON' }] }) };
  }
  const runOne = (request: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof request.query === 'string' ? request.query : '';
    const variables = (request.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
    let document: DocumentNode;
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
    const operations = document.definitions.filter((def): def is OperationNode => def.kind === 'operation');
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'no operation in document' }] };
    }
    let operation: OperationNode | undefined;
    if (operationName !== undefined) {
      operation = operations.find((op) => op.name === operationName);
      if (operation === undefined) return { data: null, errors: [{ message: `unknown operation "${operationName}"` }] };
    } else if (operations.length === 1) {
      operation = operations[0];
    } else {
      return { data: null, errors: [{ message: 'must provide operation name if query contains multiple operations' }] };
    }
    return executeOperation(store, operation, document, { ...variables });
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map((request) => (request !== null && typeof request === 'object' ? runOne(request as Record<string, unknown>) : { data: null, errors: [{ message: 'invalid request' }] }));
    return { status: 200, body: JSON.stringify(results) };
  }
  if (parsed !== null && typeof parsed === 'object') {
    return { status: 200, body: JSON.stringify(runOne(parsed as Record<string, unknown>)) };
  }
  return { status: 400, body: JSON.stringify({ errors: [{ message: 'request body must be a JSON object' }] }) };
}
