import { Node, Project, SyntaxKind, type SourceFile } from "ts-morph";

/**
 * One entry per affected file, not per call site: the patch generator
 * rewrites the whole file, so a file with several call sites needs one
 * patch and one PR, not one per call.
 */
export interface UsageMatch {
  filePath: string;
  lineNumbers: number[];
  snippet: string;
}

/** The repo's own source: dependencies, type declarations and build output
 * aren't code to patch, and node_modules would bury the real matches. */
function loadSourceFiles(repoPath: string): SourceFile[] {
  const project = new Project();
  project.addSourceFilesAtPaths([
    `${repoPath}/**/*.{ts,js}`,
    `!${repoPath}/**/node_modules/**`,
    `!${repoPath}/**/*.d.ts`,
    `!${repoPath}/**/{dist,build}/**`,
  ]);
  return project.getSourceFiles();
}

/** Names this file imports from `packageName` (default and named). */
function importedNames(sourceFile: SourceFile, packageName: string): string[] {
  return sourceFile
    .getImportDeclarations()
    .filter((imp) => imp.getModuleSpecifierValue().includes(packageName))
    .flatMap((imp) => [
      imp.getDefaultImport()?.getText(),
      ...imp.getNamedImports().map((n) => n.getName()),
    ])
    .filter((name): name is string => !!name);
}

function toMatch(sourceFile: SourceFile, lineNumbers: number[]): UsageMatch {
  return {
    filePath: sourceFile.getFilePath(),
    lineNumbers: [...new Set(lineNumbers)].sort((a, b) => a - b),
    snippet: sourceFile.getFullText(),
  };
}

// ---- method calls ----------------------------------------------------------------

/**
 * Walks a member-access chain like `stripe.charges.create` back to its
 * root identifier, returning that root plus the dotted property path after
 * it. Returns null for anything that isn't a plain identifier-rooted chain
 * (a function call result, a computed index, etc.) — those can't be
 * resolved back to a known client variable, so they're not usages we can
 * confidently match.
 */
function resolvePropertyPath(expr: Node): { root: string; path: string } | null {
  const parts: string[] = [];
  let current: Node = expr;
  while (Node.isPropertyAccessExpression(current)) {
    parts.unshift(current.getName());
    current = current.getExpression();
  }
  if (!Node.isIdentifier(current)) return null;
  return { root: current.getText(), path: parts.join(".") };
}

/**
 * Scans a repo (already checked out locally) for call sites that resolve
 * back to a client instantiated from `packageName`, e.g.
 * findUsages("./repo", "stripe", "charges.create") only matches
 * `stripe.charges.create(...)` where `stripe` was built from an import of
 * "stripe" — not comments, string literals, or unrelated identifiers that
 * merely contain the same text.
 */
export function findUsages(
  repoPath: string,
  packageName: string,
  methodName: string
): UsageMatch[] {
  const matches: UsageMatch[] = [];

  for (const sourceFile of loadSourceFiles(repoPath)) {
    const imported = importedNames(sourceFile, packageName);
    if (imported.length === 0) continue;

    // Variables built from the imported package, e.g.
    // `const stripe = new Stripe(key)` or `const stripe = Stripe(key)`.
    const clientVars = new Set<string>();
    for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = decl.getInitializer();
      const nameNode = decl.getNameNode();
      if (!init || !Node.isIdentifier(nameNode)) continue;

      const callee =
        Node.isNewExpression(init) || Node.isCallExpression(init) ? init.getExpression() : undefined;
      if (callee && Node.isIdentifier(callee) && imported.includes(callee.getText())) {
        clientVars.add(nameNode.getText());
      }
    }
    if (clientVars.size === 0) continue;

    const lineNumbers: number[] = [];
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const resolved = resolvePropertyPath(call.getExpression());
      if (!resolved || !clientVars.has(resolved.root)) continue;
      if (resolved.path !== methodName && !resolved.path.endsWith(`.${methodName}`)) continue;

      lineNumbers.push(call.getStartLineNumber());
    }

    if (lineNumbers.length > 0) matches.push(toMatch(sourceFile, lineNumbers));
  }

  return matches;
}

// ---- field reads -------------------------------------------------------------------

// An array element in a path: `classifications[].credit` is the `credit` of
// any element of `classifications`.
const ELEMENT = "[]";
// Any one property, for a field that changed under many parents:
// `country_options.*.igic` is the igic of every country in country_options.
const ANY = "*";

// Array methods whose callback gets an element, and which parameter it's in.
const ELEMENT_CALLBACKS: Record<string, number> = {
  map: 0, forEach: 0, filter: 0, find: 0, findIndex: 0, findLast: 0, findLastIndex: 0,
  some: 0, every: 0, flatMap: 0, reduce: 1, reduceRight: 1,
};

/** "classifications[].credit" -> ["classifications", "[]", "credit"] */
export function fieldSegments(fieldPath: string): string[] {
  return fieldPath
    .split(".")
    .flatMap((part) => {
      const [, name, brackets] = part.match(/^([^[\]]*)((?:\[\])*)$/) ?? [, part, ""];
      return [name, ...Array<string>(brackets!.length / 2).fill(ELEMENT)];
    })
    .filter((segment): segment is string => !!segment);
}

/**
 * The collection an identifier iterates over, if it's an array element: the
 * parameter of a `.map(c => …)`-style callback or the variable of a
 * `for (const c of …)`. Found by scope, without type information, so it
 * works on plain JS.
 */
function iteratedCollection(name: string, from: Node): Node | undefined {
  for (let scope = from.getParent(); scope; scope = scope.getParent()) {
    if (Node.isArrowFunction(scope) || Node.isFunctionExpression(scope)) {
      const params = scope.getParameters();
      const call = scope.getParentIfKind(SyntaxKind.CallExpression);
      const callee = call?.getExpression();
      if (call && callee && Node.isPropertyAccessExpression(callee) && call.getArguments()[0] === scope) {
        const index = ELEMENT_CALLBACKS[callee.getName()];
        if (index !== undefined && params[index]?.getName() === name) return callee.getExpression();
      }
      if (params.some((p) => p.getName() === name)) return undefined; // some other parameter
    }
    if (Node.isForOfStatement(scope)) {
      const init = scope.getInitializer();
      if (Node.isVariableDeclarationList(init) && init.getDeclarations().some((d) => d.getName() === name)) {
        return scope.getExpression();
      }
    }
  }
  return undefined;
}

/**
 * The property path an expression reads, outermost last:
 * `mandate?.payment_method_details["blik"].expires_after` reads
 * [payment_method_details, blik, expires_after]. A root that's an array
 * element (see iteratedCollection) is replaced by its collection's path plus
 * "[]", so `txn.classifications.map(c => c.credit)` reads
 * [classifications, [], credit].
 */
function accessPath(node: Node): string[] {
  const segments: string[] = [];
  let current: Node = node;
  for (;;) {
    if (Node.isPropertyAccessExpression(current)) {
      segments.unshift(current.getName());
      current = current.getExpression();
    } else if (Node.isElementAccessExpression(current)) {
      const key = current.getArgumentExpression();
      const literal = key && (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key));
      segments.unshift(literal ? key.getLiteralText() : ELEMENT);
      current = current.getExpression();
    } else if (Node.isNonNullExpression(current) || Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
    } else {
      break;
    }
  }
  if (Node.isIdentifier(current)) {
    const collection = iteratedCollection(current.getText(), current);
    if (collection) return [...accessPath(collection), ELEMENT, ...segments];
  }
  return segments;
}

/**
 * Whether reading `path` reads the field: lined up at the end, the two agree
 * for as long as both go, over at least two named segments (or the whole
 * field, if it has one). So for payment_method_details.blik.expires_after,
 * `d.blik.expires_after` counts but `x.expires_after` is too generic, and
 * `pi.payment_method_options.blik.expires_after` is some other object's.
 * "[]" and "*" match without counting as names: `items.map(c => c.credit)`
 * reads [[], credit], which isn't enough to mean classifications[].credit.
 */
export function readsField(path: string[], field: string[]): boolean {
  const isName = (segment: string) => segment !== ELEMENT && segment !== ANY;
  let named = 0;
  for (let i = path.length - 1, j = field.length - 1; i >= 0 && j >= 0; i--, j--) {
    const agrees = path[i] === field[j] || (field[j] === ANY && path[i] !== ELEMENT);
    if (!agrees) return false;
    if (isName(field[j])) named++;
  }
  return named >= Math.min(2, field.filter(isName).length);
}

/** The paths a destructuring pattern reads, given the path of what it destructures:
 * `const { blik: { expires_after } } = mandate.payment_method_details` reads
 * [payment_method_details, blik] and [payment_method_details, blik, expires_after]. */
function destructuredPaths(pattern: Node, base: string[]): string[][] {
  if (!Node.isObjectBindingPattern(pattern)) return [];
  return pattern.getElements().flatMap((element) => {
    const property = element.getPropertyNameNode()?.getText() ?? element.getName();
    const path = [...base, property.replace(/^["']|["']$/g, "")];
    return [path, ...destructuredPaths(element.getNameNode(), path)];
  });
}

/** What a destructuring pattern destructures, as a path: the initializer of
 * `const {…} = x.y`, or the collection element for a callback parameter or
 * `for (const {…} of …)`. */
function destructuredBase(pattern: Node): string[] | undefined {
  const holder = pattern.getParent();
  if (Node.isVariableDeclaration(holder)) {
    const init = holder.getInitializer();
    if (init) return accessPath(init);
    const forOf = holder.getParent()?.getParent();
    return Node.isForOfStatement(forOf) ? [...accessPath(forOf.getExpression()), ELEMENT] : undefined;
  }
  if (Node.isParameterDeclaration(holder)) {
    const fn = holder.getParent();
    const call = fn?.getParentIfKind(SyntaxKind.CallExpression);
    const callee = call?.getExpression();
    if (fn && call && callee && Node.isPropertyAccessExpression(callee) && call.getArguments()[0] === fn) {
      const index = ELEMENT_CALLBACKS[callee.getName()];
      const params = (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) ? fn.getParameters() : [];
      if (index !== undefined && params[index] === holder) return [...accessPath(callee.getExpression()), ELEMENT];
    }
    return [];
  }
  return undefined;
}

/**
 * Scans a repo for code that reads a field of an object the SDK returns,
 * e.g. findFieldUsages("./repo", "stripe", "payment_method_details.blik.expires_after")
 * matches `mandate.payment_method_details.blik.expires_after`,
 * `details?.blik?.expires_after` and
 * `const { expires_after } = mandate.payment_method_details.blik`.
 *
 * There's no type information in plain JS, so this matches on the path
 * itself (see readsField). A one-segment field (`livemode`) is too common a
 * name to match anywhere, so it's only looked for in files that import the
 * package. A false match costs a model call that finds nothing to change.
 */
export function findFieldUsages(repoPath: string, packageName: string, fieldPath: string): UsageMatch[] {
  const field = fieldSegments(fieldPath);
  // With no name in it ("*", "[]"), every property read would match.
  if (!field.some((segment) => segment !== ELEMENT && segment !== ANY)) return [];
  const matches: UsageMatch[] = [];

  for (const sourceFile of loadSourceFiles(repoPath)) {
    if (field.length === 1 && importedNames(sourceFile, packageName).length === 0) continue;

    const lineNumbers: number[] = [];
    const accesses = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.ElementAccessExpression),
    ];
    for (const access of accesses) {
      if (readsField(accessPath(access), field)) lineNumbers.push(access.getStartLineNumber());
    }
    for (const pattern of sourceFile.getDescendantsOfKind(SyntaxKind.ObjectBindingPattern)) {
      if (!Node.isObjectBindingPattern(pattern.getParent()?.getParent())) {
        // only outermost patterns; destructuredPaths walks the nested ones
        const base = destructuredBase(pattern);
        if (base && destructuredPaths(pattern, base).some((path) => readsField(path, field))) {
          lineNumbers.push(pattern.getStartLineNumber());
        }
      }
    }

    if (lineNumbers.length > 0) matches.push(toMatch(sourceFile, lineNumbers));
  }

  return matches;
}
