/**
 * Build the CLI.
 *
 * esbuild for the JS, tsc for the .d.ts. esbuild does not typecheck — it strips types — so the
 * `prepublishOnly` script runs `typecheck` first. A published CLI that fails on `import` because a
 * type error slipped through is the one bug users cannot work around.
 *
 * esbuild and tweetnacl stay EXTERNAL rather than bundled into the output. esbuild ships
 * platform-specific binaries, so inlining it produces a package that only runs on the machine that
 * built it; tweetnacl is external for a different reason — it is the signing code, and a reviewer
 * should be able to check the exact published dependency rather than a copy embedded in our bundle.
 *
 * TWO SEPARATE BUILDS, because the shebang is not shared. esbuild's `banner` applies to every output
 * of a build, so a single pass would also put `#!/usr/bin/env node` at the top of dist/index.js — the
 * library entry, which is imported rather than executed.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

const common = {
    outdir: 'dist',
    platform: 'node',
    target: 'node20',
    format: 'esm',
    bundle: true,
    external: ['esbuild', 'tweetnacl'],
    logLevel: 'info',
};

// The executable. Only this one gets the shebang.
await build({ ...common, entryPoints: { cli: 'src/cli.ts' }, banner: { js: '#!/usr/bin/env node' } });

// The library entry. Must NOT pull in cli.ts, which calls main() at import time — that is why
// VERSION lives in its own module.
await build({ ...common, entryPoints: { index: 'src/index.ts' } });

// Types for anyone importing the package programmatically, not just running the binary.
execFileSync('npx', ['tsc', '--emitDeclarationOnly'], { stdio: 'inherit' });
console.log('built dist/cli.js + dist/index.js + types');
