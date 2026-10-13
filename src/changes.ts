// What a breaking change is, apart from how it's found or fixed. Kept free
// of config and API clients, so modules that only need these (and their
// tests) load without API keys.

export interface DetectedChange {
  version: string; // release tag the change came from, e.g. "v18.0.0"
  entry: string; // human-readable changelog line, e.g. "v18.0.0: `charges.create` removed. Use `paymentIntents.create` instead."
  // Exactly one of these says what to scan for:
  methodName?: string; // a method callers call, e.g. "charges.create"
  fieldPath?: string; // a field callers read off a returned object, e.g. "payment_method_details.blik.expires_after"; "[]" marks array elements
  resource?: string; // for a field: the client resource whose objects carry it, e.g. "customers", "issuing.cards"
  apiVersion?: string; // the API version the SDK now pins; in TypeScript, code pinning another one stops compiling
  // The changelog item that states the change (its list entry, with any
  // sub-items), as the notes have it. Fix branches are keyed on it: the notes
  // say the same thing every run, while the model may word or name a change
  // differently from one run to the next.
  source?: string;
  // Other entries of the same release's notes that name what this one does
  // (see relatedLines): a replacement the entry doesn't name, or how the new
  // version must be called. Context for the patch, not changes of their own.
  related?: string[];
}

/** The method or field a change is about, for logs, branch names and PR titles. */
export function changeTarget(change: DetectedChange): string {
  return change.fieldPath ?? change.methodName ?? (change.apiVersion ? "apiVersion" : "");
}

// How a patch marks code it couldn't fix (something removed with no
// replacement) for a person to decide on.
export const REVIEW_MARKER = "TODO(api-dependabot)";
