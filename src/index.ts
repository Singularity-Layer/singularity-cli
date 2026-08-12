/**
 * The programmatic entry point: `import { ... } from '@singularity-layer/cli'`.
 *
 * WHY A LIBRARY SURFACE AT ALL. The CLI is a thin wrapper over signed HTTP, and the parts worth
 * reusing are the parts that are easy to get subtly wrong: the signature scheme (a wrong byte gives
 * an unexplained 401), the micro-USDC formatting (a float gives numbers that disagree with the
 * ledger), and the bundler configuration (a wrong target gives a processor that fails at runtime
 * inside a paid run). Anyone building a dashboard, a CI step, or an agent that deploys processors
 * should not reimplement those.
 *
 * WHAT IS DELIBERATELY NOT EXPORTED: the subcommand implementations. They call process.exit and
 * write to stderr, which is right for a terminal and wrong inside someone else's program. If a
 * command's behaviour is worth having programmatically, it gets extracted properly rather than
 * exposed as-is.
 */

export { api, loadKeypair, bs58, parseArgs, type Keypair, type Flags, type ApiOpts } from './auth.js';
export { bundleProcessor, MAX_BUNDLE_BYTES, type BundleResult } from './bundle.js';
export { usd, when, coerce } from './format.js';
export { VERSION } from './version.js';
