/**
 * Bundle a processor on the PUBLISHER's machine.
 *
 * This is the whole reason npm packages and multi-file TypeScript processors are possible. The
 * alternative — accepting a package.json and running `npm install` on our infrastructure — means
 * executing arbitrary postinstall scripts on a box that holds platform credentials. No amount of
 * scanning makes that safe, so the bundler runs here, where the code's author already has a machine
 * they trust and dependencies they chose.
 *
 * WHAT CROSSES THE BOUNDARY: one bundled module, plus the pre-bundle sources for provenance.
 * `node_modules` never does.
 *
 * The target is a Cloudflare Worker isolate, so the output has to be an ES module with no Node
 * built-ins beyond what `nodejs_compat` provides, and no filesystem or process access. esbuild is
 * configured accordingly, and a dependency that reaches for something unavailable fails HERE — at
 * deploy time, on the publisher's terminal — rather than as an opaque runtime error inside a paid run.
 */

import { build, type BuildResult, type Plugin } from 'esbuild';
import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

/** Mirrors PROCESSOR_MAX_CODE_BYTES on the server. Failing here beats a 413 after a wallet prompt. */
export const MAX_BUNDLE_BYTES = 1_048_576;

export interface BundleResult {
    bundle: string;
    files: Record<string, string>;
    meta: {
        bundler: string;
        entry: string;
        bytes: number;
        /** sha256 per source file, so "the code running is the code you wrote" is checkable later. */
        sources: Record<string, string>;
    };
    warnings: string[];
}

/**
 * Node built-ins a Worker isolate does not have, even with nodejs_compat.
 *
 * Caught at bundle time with a readable message naming the importer, because the runtime failure is
 * a module-evaluation error inside a paid run — the publisher sees "processor failed", the buyer has
 * already paid, and nothing points at the real cause.
 */
const UNAVAILABLE_BUILTINS = new Set([
    'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
    'child_process', 'node:child_process',
    'worker_threads', 'node:worker_threads',
    'net', 'node:net', 'tls', 'node:tls', 'dns', 'node:dns',
    'cluster', 'node:cluster', 'os', 'node:os', 'v8', 'node:v8',
    'repl', 'node:repl', 'vm', 'node:vm',
]);

function guardBuiltins(): Plugin {
    return {
        name: 'sgl-guard-builtins',
        setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
                if (!UNAVAILABLE_BUILTINS.has(args.path)) return null;
                return {
                    errors: [{
                        text: `"${args.path}" is not available in a processor. Processors run in a `
                            + 'Cloudflare isolate: there is no filesystem, no child processes and no raw '
                            + 'sockets. Outbound HTTPS to hosts you declared in egress.allow is the way '
                            + 'out. Imported by ' + (args.importer || 'your entry file') + '.',
                    }],
                };
            });
        },
    };
}

/**
 * The sources that were actually COMPILED into the bundle, for provenance.
 *
 * DERIVED FROM ESBUILD'S METAFILE, not from walking the directory. That distinction is the whole
 * security property of this function, and the walking version was wrong in a way that mattered:
 *
 *   `files` is UPLOADED to us. A directory walk that kept every .json under the working directory
 *   would upload `credentials.json`, `service-account.json`, or a stray `id.json` — and because
 *   statSync FOLLOWS SYMLINKS, a link like `wallet/id.json -> ~/.config/solana/id.json` would send
 *   the publisher's WALLET KEY to the platform, filed as provenance. Nobody would ever see it
 *   happen. (Found by adversarial review, before anything shipped.)
 *
 * The metafile lists exactly the files esbuild read to produce this bundle. That set is both safer
 * and more honest: provenance should describe what was compiled, and a file the compiler never
 * touched is not part of what runs.
 *
 * Three further guards, because a metafile path is still a path:
 *   • node_modules is excluded — the dependency's code is already inlined in the bundle, and
 *     uploading it again would be megabytes of somebody else's source
 *   • anything resolving outside the working directory is refused, so `../../.ssh/config` cannot
 *     arrive as a key
 *   • lstat, not stat, so a symlink is skipped rather than followed
 */
function collectSources(dir: string, inputs: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const root = realpathSync(dir);

    for (const rel of inputs) {
        // esbuild also reports synthetic entries — `<stdin>`, plugin namespaces like `ns:thing`.
        // Those are filtered by lstat failing below rather than by pattern-matching the string: a
        // "looks like a namespace" test on a colon would also reject `C:\project\...` on Windows.
        if (rel.split('/').includes('node_modules')) continue;

        const full = isAbsolute(rel) ? rel : join(dir, rel);
        let st;
        try { st = lstatSync(full); } catch { continue; }
        // A symlink is skipped, never followed. This is the line that stops a link pointing at a
        // wallet keypair from being read and uploaded.
        if (!st.isFile()) continue;

        // CONFINEMENT, checked on the REAL path. Comparing the unresolved path would let `a/../..`
        // pass a prefix test while reading somewhere else entirely.
        const real = realpathSync(full);
        if (real !== root && !real.startsWith(root + sep)) continue;

        // Provenance is not worth shipping megabytes for, and a huge "source" file is nearly always
        // generated or vendored data.
        if (st.size > 256 * 1024) continue;

        out[relative(root, real)] = readFileSync(real, 'utf8');
    }
    return out;
}

/**
 * Bundle `entry` into one ES module.
 *
 * `minify` is off by default on purpose: the publisher reads their own errors, and a minified stack
 * trace in a run log is worthless to them. Size is rarely the constraint at 1 MiB.
 */
export async function bundleProcessor(opts: {
    entry: string;
    cwd: string;
    minify?: boolean;
}): Promise<BundleResult> {
    const { entry, cwd } = opts;
    if (!existsSync(entry)) {
        throw new Error(`no entry file at ${entry}`);
    }

    let result: BuildResult;
    try {
        result = await build({
            entryPoints: [entry],
            absWorkingDir: cwd,
            bundle: true,
            write: false,
            // The list of files esbuild actually read. This IS the provenance set — see
            // collectSources() for why a directory walk was a wallet-key exfiltration path.
            metafile: true,
            format: 'esm',
            // The isolate's own target. `browser` would pull in DOM shims that do not exist; `node`
            // would resolve Node built-ins we cannot provide.
            platform: 'neutral',
            target: 'es2022',
            mainFields: ['module', 'main'],
            conditions: ['worker', 'browser', 'import', 'default'],
            minify: opts.minify === true,
            // Keeps the publisher's own function and variable names in run errors.
            keepNames: true,
            plugins: [guardBuiltins()],
            logLevel: 'silent',
        });
    } catch (e) {
        // esbuild's message already names the file and line; prefixing ours would bury it.
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`bundling failed:\n${msg}`);
    }

    const output = result.outputFiles?.[0];
    if (!output) throw new Error('bundling produced no output');
    const bundle = new TextDecoder().decode(output.contents);

    const bytes = new TextEncoder().encode(bundle).byteLength;
    if (bytes > MAX_BUNDLE_BYTES) {
        throw new Error(
            `bundle is ${(bytes / 1024).toFixed(0)} KiB, over the ${MAX_BUNDLE_BYTES / 1024} KiB limit. `
            + 'Try --minify, or drop a heavy dependency.',
        );
    }

    const files = collectSources(cwd, Object.keys(result.metafile?.inputs ?? {}));
    const sources: Record<string, string> = {};
    for (const [path, src] of Object.entries(files)) {
        sources[path] = createHash('sha256').update(src).digest('hex');
    }

    return {
        bundle,
        files,
        meta: {
            bundler: `esbuild`,
            entry: relative(cwd, entry),
            bytes,
            sources,
        },
        warnings: (result.warnings ?? []).map((w) => w.text),
    };
}
