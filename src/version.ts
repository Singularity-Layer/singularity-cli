/**
 * The version, in its own module for one specific reason.
 *
 * cli.ts CALLS main() at import time — that is what makes it an executable. So anything that
 * re-exports from cli.ts drags that side effect along with it: `import { VERSION } from
 * '@singularity-layer/cli'` inside someone's dashboard would parse process.argv, print help, and
 * exit their process. The bundler makes it worse, not better, by inlining the call into dist/index.js.
 *
 * Kept in sync with package.json by the release workflow, which is the only thing that bumps either.
 */
export const VERSION = '0.2.1';
