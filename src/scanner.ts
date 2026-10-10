import path from "node:path";
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
  const project = new Project({ compilerOptions: { allowJs: true } });
  project.addSourceFilesAtPaths([
    `${repoPath}/**/*.{ts,tsx,js,jsx,mjs,cjs}`,
    `!${repoPath}/**/node_modules/**`,
    `!${repoPath}/**/*.d.ts`,
    `!${repoPath}/**/{dist,build}/**`,
  ]);
  return project.getSourceFiles();
}

/** The package itself ("stripe", "stripe/esm"), not another one whose name
 * merely contains it ("@stripe/stripe-js" is the browser library). */
function isPackage(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

/** The module a `require("...")` call loads, or undefined for anything else. */
function requiredModule(node: Node | undefined): string | undefined {
  if (!node || !Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  const [arg] = node.getArguments();
  if (!Node.isIdentifier(callee) || callee.getText() !== "require" || !arg) return undefined;
  return Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg) ? arg.getLiteralValue() : undefined;
}

/** Drops wrappers that don't change what an expression refers to: (x), x!, x as T, await x. */
function unwrap(node: Node): Node {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isAwaitExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/** Local names bound to the package's own exports: `import Stripe from`,
 * `import { Stripe as S } from`, `import * as S from`, `const Stripe =
 * require(...)`, `const { Stripe } = require(...)`. */
function packageBindings(sourceFile: SourceFile, packageName: string): Set<string> {
  const names = new Set<string>();
  for (const imp of sourceFile.getImportDeclarations()) {
    if (!isPackage(imp.getModuleSpecifierValue(), packageName)) continue;
    const def = imp.getDefaultImport();
    if (def) names.add(def.getText());
    const ns = imp.getNamespaceImport();
    if (ns) names.add(ns.getText());
    for (const named of imp.getNamedImports()) names.add(named.getAliasNode()?.getText() ?? named.getName());
  }
  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init) continue;
    // require("stripe"), or require("stripe").Stripe / .default
    const value = unwrap(init);
    const required = requiredModule(value) ??
      (Node.isPropertyAccessExpression(value) ? requiredModule(unwrap(value.getExpression())) : undefined);
    if (!required || !isPackage(required, packageName)) continue;
    for (const name of boundNames(decl.getNameNode())) names.add(name);
  }
  return names;
}

/** The identifiers a declaration's name binds: `x`, or each name in `{ a, b: c }`. */
function boundNames(nameNode: Node): string[] {
  if (Node.isIdentifier(nameNode)) return [nameNode.getText()];
  if (Node.isObjectBindingPattern(nameNode)) {
    return nameNode.getElements().flatMap((el) => boundNames(el.getNameNode()));
  }
  return [];
}

/** Whether the file imports or requires the package at all. */
function usesPackage(sourceFile: SourceFile, packageName: string): boolean {
  return packageBindings(sourceFile, packageName).size > 0 ||
    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => {
      const mod = requiredModule(c);
      return mod !== undefined && isPackage(mod, packageName);
    });
}

function toMatch(sourceFile: SourceFile, lineNumbers: number[]): UsageMatch {
  return {
    filePath: sourceFile.getFilePath(),
    lineNumbers: [...new Set(lineNumbers)].sort((a, b) => a - b),
    snippet: sourceFile.getFullText(),
  };
}

// ---- method calls ----------------------------------------------------------------

/** What one file knows about clients built from the package. */
interface Clients {
  packageNames: Set<string>; // bound to the package itself (static use: Stripe.webhooks...)
  vars: Set<string>; // variables holding a client
  props: Set<string>; // this.<prop> holding a client
  resources: Map<string, string>; // name -> path on a client: `const { customers } = stripe`
}

/** Whether `node` evaluates to a client: `new Stripe(k)`, `Stripe(k)`,
 * `new S.Stripe(k)`, `require("stripe")(k)`, or a known client variable. */
function isClient(node: Node, c: Clients, packageName: string): boolean {
  const n = unwrap(node);
  if (Node.isIdentifier(n)) return c.vars.has(n.getText());
  if (Node.isPropertyAccessExpression(n) && unwrap(n.getExpression()).getKind() === SyntaxKind.ThisKeyword) {
    return c.props.has(n.getName());
  }
  if (Node.isNewExpression(n) || Node.isCallExpression(n)) {
    const callee = unwrap(n.getExpression());
    if (Node.isIdentifier(callee)) return c.packageNames.has(callee.getText());
    if (Node.isPropertyAccessExpression(callee)) {
      // new S.Stripe(k), S.default(k), require("stripe").Stripe(k); not a helper like S.createFetchHttpClient()
      const root = unwrap(callee.getExpression());
      const fromPackage = (Node.isIdentifier(root) && c.packageNames.has(root.getText())) ||
        isPackage(requiredModule(root) ?? "", packageName);
      return fromPackage && (Node.isNewExpression(n) || /^[A-Z]|^default$/.test(callee.getName()));
    }
    const mod = requiredModule(callee);
    return mod !== undefined && isPackage(mod, packageName);
  }
  return false;
}

/**
 * The client path a call's receiver resolves to: `stripe.charges.create` ->
 * "charges.create", `this.stripe["customers"].list` -> "customers.list",
 * `customers.create` after `const { customers } = stripe` -> "customers.create",
 * `Stripe.webhooks().constructEvent` -> "webhooks.constructEvent". Null when the
 * chain doesn't start from a client or the package.
 */
function clientPath(expr: Node, c: Clients, packageName: string): string | null {
  const parts: string[] = [];
  let current = unwrap(expr);
  for (;;) {
    if (Node.isPropertyAccessExpression(current)) {
      if (isClient(current, c, packageName)) break; // this.stripe
      parts.unshift(current.getName());
      current = unwrap(current.getExpression());
    } else if (Node.isElementAccessExpression(current)) {
      const arg = current.getArgumentExpression();
      if (!arg || !(Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) return null;
      parts.unshift(arg.getLiteralValue());
      current = unwrap(current.getExpression());
    } else if (Node.isCallExpression(current) && Node.isPropertyAccessExpression(unwrap(current.getExpression()))) {
      current = unwrap(current.getExpression()); // webhooks() in a chain reads as webhooks
    } else {
      break;
    }
  }
  if (Node.isIdentifier(current)) {
    const name = current.getText();
    const resource = c.resources.get(name);
    if (resource !== undefined) return [resource, ...parts].join(".");
    if (c.vars.has(name) || c.packageNames.has(name)) return parts.join(".");
    return null;
  }
  return isClient(current, c, packageName) ? parts.join(".") : null;
}

/** Grows `c` with everything in the file that holds a client, until nothing new turns up. */
function collectClients(sourceFile: SourceFile, c: Clients, packageName: string): void {
  for (let changed = true; changed; ) {
    const size = c.vars.size + c.props.size + c.resources.size;
    for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = decl.getInitializer();
      const name = decl.getNameNode();
      if (!init) continue;
      if (Node.isIdentifier(name)) {
        if (isClient(init, c, packageName)) c.vars.add(name.getText());
        else {
          const path = clientPath(init, c, packageName);
          if (path) c.resources.set(name.getText(), path); // const customers = stripe.customers
        }
      } else if (Node.isObjectBindingPattern(name)) {
        const base = isClient(init, c, packageName) ? "" : clientPath(init, c, packageName);
        if (base === null) continue;
        for (const el of name.getElements()) {
          const local = el.getNameNode();
          if (!Node.isIdentifier(local)) continue;
          const prop = el.getPropertyNameNode()?.getText() ?? local.getText();
          c.resources.set(local.getText(), base ? `${base}.${prop}` : prop);
        }
      }
    }
    for (const bin of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken || !isClient(bin.getRight(), c, packageName)) continue;
      const left = unwrap(bin.getLeft());
      if (Node.isIdentifier(left)) c.vars.add(left.getText());
      else if (Node.isPropertyAccessExpression(left) && unwrap(left.getExpression()).getKind() === SyntaxKind.ThisKeyword) {
        c.props.add(left.getName());
      }
    }
    for (const prop of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyDeclaration)) {
      const init = prop.getInitializer();
      if (init && isClient(init, c, packageName)) c.props.add(prop.getName());
    }
    // A TypeScript parameter typed as the client itself: `function charge(stripe: Stripe)`. Not
    // `Stripe.Customer`, which is a resource the client returns.
    for (const param of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
      const type = param.getTypeNode()?.getText();
      const name = param.getNameNode();
      if (type && Node.isIdentifier(name) && c.packageNames.has(type)) c.vars.add(name.getText());
    }
    changed = c.vars.size + c.props.size + c.resources.size !== size;
  }
}

/** What a file exports that is a client: "default"/"module" for the whole
 * export, otherwise the export's name. */
function exportedClients(sourceFile: SourceFile, c: Clients, packageName: string): Set<string> {
  const out = new Set<string>();
  for (const stmt of sourceFile.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarations()) if (c.vars.has(decl.getName())) out.add(decl.getName());
  }
  for (const assignment of sourceFile.getExportAssignments()) {
    if (isClient(assignment.getExpression(), c, packageName)) out.add("default");
  }
  for (const exp of sourceFile.getExportDeclarations()) {
    if (exp.getModuleSpecifier()) continue;
    for (const named of exp.getNamedExports()) {
      if (c.vars.has(named.getName())) out.add(named.getAliasNode()?.getText() ?? named.getName());
    }
  }
  for (const bin of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const left = bin.getLeft().getText();
    const right = unwrap(bin.getRight());
    if (left === "module.exports" && isClient(right, c, packageName)) out.add("default");
    else if (left === "module.exports" && Node.isObjectLiteralExpression(right)) {
      for (const prop of right.getProperties()) {
        const name = Node.isShorthandPropertyAssignment(prop) || Node.isPropertyAssignment(prop) ? prop.getName() : undefined;
        const value = Node.isPropertyAssignment(prop) ? prop.getInitializer() : Node.isShorthandPropertyAssignment(prop) ? prop.getNameNode() : undefined;
        if (name && value && isClient(value, c, packageName)) out.add(name);
      }
    } else {
      const named = /^(?:module\.)?exports\.(\w+)$/.exec(left);
      if (named && isClient(right, c, packageName)) out.add(named[1]);
    }
  }
  return out;
}

/** The repo file a relative import points at, trying the usual extensions and index files. */
function resolveLocal(from: SourceFile, specifier: string, byPath: Map<string, SourceFile>): SourceFile | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(from.getFilePath()), specifier);
  const stem = base.replace(/\.(m|c)?js$/, "");
  for (const candidate of [base, ...EXTENSIONS.map((e) => `${stem}${e}`), ...EXTENSIONS.map((e) => `${base}/index${e}`)]) {
    const file = byPath.get(candidate);
    if (file) return file;
  }
  return undefined;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Adds to `c` the names this file imports from repo modules that export a client. */
function importClients(sourceFile: SourceFile, c: Clients, exported: Map<SourceFile, Set<string>>,
                       byPath: Map<string, SourceFile>): void {
  for (const imp of sourceFile.getImportDeclarations()) {
    const target = resolveLocal(sourceFile, imp.getModuleSpecifierValue(), byPath);
    const names = target && exported.get(target);
    if (!names?.size) continue;
    const def = imp.getDefaultImport();
    if (def && names.has("default")) c.vars.add(def.getText());
    for (const named of imp.getNamedImports()) {
      if (names.has(named.getName())) c.vars.add(named.getAliasNode()?.getText() ?? named.getName());
    }
  }
  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    const spec = init && requiredModule(unwrap(init));
    const target = spec ? resolveLocal(sourceFile, spec, byPath) : undefined;
    const names = target && exported.get(target);
    if (!names?.size) continue;
    const name = decl.getNameNode();
    if (Node.isIdentifier(name) && names.has("default")) c.vars.add(name.getText());
    if (Node.isObjectBindingPattern(name)) {
      for (const el of name.getElements()) {
        const prop = el.getPropertyNameNode()?.getText() ?? el.getName();
        if (names.has(prop)) c.vars.add(el.getName());
      }
    }
  }
}

/**
 * Scans a repo (already checked out locally) for call sites that resolve back
 * to a client built from `packageName`, e.g. findUsages("./repo", "stripe",
 * "charges.create") matches `stripe.charges.create(...)` however `stripe` got
 * there: an import or a require, a client built in one module and imported in
 * another, `this.stripe`, an alias, `const { charges } = stripe`, a TypeScript
 * parameter typed `Stripe`, or bracket access. Not comments, strings, or
 * unrelated identifiers that merely contain the same text. A method name equal
 * to the package's own name (`Stripe`) means calling the package itself.
 */
export function findUsages(
  repoPath: string,
  packageName: string,
  methodName: string
): UsageMatch[] {
  const files = loadSourceFiles(repoPath);
  const byPath = new Map(files.map((f) => [f.getFilePath() as string, f]));
  const clients = new Map<SourceFile, Clients>();
  const exported = new Map<SourceFile, Set<string>>();
  // Two rounds, so a client created in one module and re-exported by a
  // second is still recognised in a third.
  for (let round = 0; round < 3; round++) {
    for (const file of files) {
      const c = clients.get(file) ?? {
        packageNames: packageBindings(file, packageName), vars: new Set(), props: new Set(), resources: new Map(),
      };
      importClients(file, c, exported, byPath);
      collectClients(file, c, packageName);
      clients.set(file, c);
    }
    for (const file of files) exported.set(file, exportedClients(file, clients.get(file)!, packageName));
  }

  const callsPackage = methodName.toLowerCase() === packageName.toLowerCase();
  const matches: UsageMatch[] = [];
  for (const file of files) {
    const c = clients.get(file)!;
    const lineNumbers: number[] = [];
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (callsPackage) {
        // Stripe(key) without `new`: a call whose callee is the package itself.
        const callee = unwrap(call.getExpression());
        if ((Node.isIdentifier(callee) && c.packageNames.has(callee.getText())) ||
            isPackage(requiredModule(callee) ?? "", packageName)) {
          lineNumbers.push(call.getStartLineNumber());
        }
        continue;
      }
      const resolved = clientPath(call.getExpression(), c, packageName);
      if (resolved === null) continue;
      if (resolved !== methodName && !resolved.endsWith(`.${methodName}`)) continue;
      lineNumbers.push(call.getStartLineNumber());
    }
    if (lineNumbers.length > 0) matches.push(toMatch(file, lineNumbers));
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
    if (field.length === 1 && !usesPackage(sourceFile, packageName)) continue;

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
