// Downloads the SDK release each eval case comes from (see sdkTypes.ts), so the
// eval itself never runs npm. CI runs this in a step without the secrets.
import { cases } from "./fixtures.js";
import { sdkRoot } from "./sdkTypes.js";

// The cases' releases, and 10.0.0 for the end-to-end eval (e2e.ts).
const fromCases = cases.map((c) => c.changelogEntry.match(/^v(\S+?):/)?.[1]).filter((v) => v !== undefined);
const versions = [...new Set([...fromCases, "10.0.0"])];
for (const version of versions) console.log(`stripe ${version}: ${sdkRoot("stripe", version)}`);
