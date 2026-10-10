import { ts } from "ts-morph";

// A fix changes a few lines. Correct patches in the eval kept 57-100% of the
// original's non-blank lines; a file replaced by a comment, or rewritten from
// scratch, keeps almost none. A patch may change up to this share of the
// lines, or MIN_FREE_LINES of them in a short file.
export const MAX_CHANGED_SHARE = 0.6;
export const MIN_FREE_LINES = 3;

/** The original's non-blank lines that don't appear, unchanged apart from
 * indentation, in the patched file. */
export function changedLines(before: string, after: string): { changed: number; total: number } {
  const original = before.split("\n").map((l) => l.trim()).filter(Boolean);
  const patched = new Set(after.split("\n").map((l) => l.trim()));
  return { changed: original.filter((l) => !patched.has(l)).length, total: original.length };
}

/** Syntax errors in `code` as TypeScript or JavaScript reads it (types aren't
 * checked: the target repo's dependencies, and so the SDK's types, aren't
 * installed where the agent runs). */
export function syntaxErrors(filePath: string, code: string): string[] {
  const { diagnostics = [] } = ts.transpileModule(code, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest },
  });
  return diagnostics.map((d) => {
    const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined;
    return `${where ? `line ${where}: ` : ""}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

/** Why a patch shouldn't become a pull request, or null if it can. */
export function patchProblem(filePath: string, before: string, after: string): string | null {
  if (!after.trim()) return "the patch is empty";
  const errors = syntaxErrors(filePath, after);
  if (errors.length) return `the patched file doesn't parse (${errors[0]})`;
  const { changed, total } = changedLines(before, after);
  if (changed > Math.max(MIN_FREE_LINES, MAX_CHANGED_SHARE * total)) {
    return `the patch changes ${changed} of the file's ${total} lines; a fix changes a few lines, it doesn't rewrite the file`;
  }
  return null;
}
