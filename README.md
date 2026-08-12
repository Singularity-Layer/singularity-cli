# `singularity` — Singularity developer CLI

Build on the Singularity Cloud Network from your terminal.

```bash
npm i -g @singularity-layer/cli
singularity --help
```

Requires Node 20+ and a Solana keypair (`solana-keygen new`). No account, no API key, no dashboard
login — your wallet *is* the account.

## Processors

A Processor is a loop you write; we host it, run it on demand, and buyers pay **you** directly per
call. There is no platform cut and we never custody your money: an x402 payment is a USDC transfer
from the buyer's wallet to yours.

```bash
mkdir my-loop && cd my-loop
singularity processors init my-loop      # scaffolds processor.json + processor.js
singularity processors deploy            # prints the invoke token ONCE
singularity processors run '{"hi":1}'    # invoke it, print the output
singularity processors publish           # instantly public — no review step
singularity processors logs              # runs + failure rate
singularity processors revenue           # sales and compute spend, everything you own
```

Your loop is a standard Worker module:

```js
export default {
  async fetch(request) {
    const { input } = await request.json();
    // Call APIs and models with fetch(). Credentials for the hosts you declared
    // are injected for you, so no keys belong in this file.
    return Response.json({ ok: true, received: input });
  }
}
```

### TypeScript and npm packages

Add `--bundle` (or `"$bundle": true` in `processor.json`) and the CLI runs esbuild locally, so
`import` and npm dependencies work:

```bash
npm i zod
singularity processors deploy --bundle --entry processor.ts
```

**The bundling happens on your machine, on purpose.** We never run `npm install` for you: a
postinstall script is arbitrary code, and running it on infrastructure that holds platform
credentials is not something scanning makes safe. Your bundle crosses the boundary; your
`node_modules` never does.

The bundler targets a Worker isolate, so a dependency reaching for `fs`, `child_process` or raw
sockets fails **here**, on your terminal, naming the importer — instead of dying inside a run a buyer
has already paid for.

Going back to a single file needs `--no-bundle`, because a stored bundle keeps winning at load time
and plain `code` would silently never take effect.

### Invoking

```bash
singularity processors run '{"n":10}'    # JSON in, output out
singularity processors call -i           # prompts per field, from your own input_schema
singularity processors schema            # what buyers and agents see
```

### Secrets

Declare a secret in `processor.json`, then set its value:

```bash
singularity processors secrets OPENAI_API_KEY=sk-...
singularity processors env list                 # which are declared, which are set
singularity processors env unset OPENAI_API_KEY
```

Values are write-only *to you*: we never hand one back through the API.

**Two modes, chosen per secret.** The default is the strong one:

```json
"secrets": [
  { "name": "OPENAI_API_KEY", "hosts": ["api.openai.com"],
    "inject": { "header": "Authorization", "format": "Bearer {value}" } },
  { "name": "SIGNING_KEY", "mode": "env" }
]
```

`inject` (the default) — **the value never enters your isolate.** You call `fetch()` with no
credential and the egress gateway adds the header server-side, for the hosts you declared and nowhere
else. Code that never holds a key cannot leak the key.

`mode: "env"` — **your code holds the value**, via `await SGL.secrets.get('SIGNING_KEY')`. This is a
real downgrade and it is opt-in for exactly that reason: once your code has the value it can print it
into your logs, or send it to any host in your egress allowlist, and we cannot stop either. Use it
only for credentials that genuinely cannot be an outbound header — a key you sign with locally, or a
value an SDK insists on reading itself. The alternative most people reach for otherwise is
hard-coding the secret in their source, which is worse in every way.

`singularity processors env list` shows which of yours is which.

## Processor state

A processor is a fresh isolate every run, so anything you want to keep has to go somewhere:

```js
// Key/value — a cursor, a cache, a dedupe set. Values are opaque strings, byte-exact.
await SGL.kv.put('cursor', '2026-08-12');
const cursor = await SGL.kv.get('cursor');

// Compare-and-swap, for a counter or a lock. Concurrent runs are the normal case.
const cur = await SGL.kv.getWithVersion('count');
await SGL.kv.put('count', String(Number(cur.value) + 1), { ifVersion: cur.version });

// Objects — a generated PDF, an image, a dataset.
await SGL.files.put('reports/august.pdf', bytes, { contentType: 'application/pdf' });
const { url } = await SGL.files.downloadUrl('reports/august.pdf', { ttlSeconds: 3600 });
```

`downloadUrl` gives you a signed, expiring link a buyer can fetch with **no credential**. It is
always served as an attachment with a forced `application/octet-stream` type — your declared type is
never echoed — so a stored HTML or SVG file cannot execute. Treat it as a bearer link: anyone who
gets it can download until it expires.

None of this needs an `egress.allow` entry. It is not the network.

### Turning it off without losing it

```bash
singularity processors pause      # buyers and token callers refused; no payment is taken
singularity processors resume
```

`pause` is the switch to reach for when an upstream key hits its quota or a loop misbehaves.
Unlisting only hides you from the catalogue — the endpoint keeps answering anyone with the URL — and
`delete` burns the slug forever. While paused you can still invoke it yourself with your wallet, so
you can verify a fix before resuming.

### For scripts and agents

Every command takes `--json`:

```bash
singularity processors list --json | jq '.processors[] | select(.paused_at)'
singularity processors run '{"n":1}' --json
```

## Auth

A per-request Solana wallet signature, using `~/.config/solana/id.json` by default (`--keypair
<path>`, `SINGULARITY_KEYPAIR`, or `singularity processors configure` to change it). **The key never
leaves your machine** — only a signature is sent, and it covers the method, the path and a hash of the
body, so it authorizes exactly one request and cannot be replayed against another.

## Programmatic use

```ts
import { bundleProcessor, api, loadKeypair, usd } from '@singularity-layer/cli';
```

The exported pieces are the ones that are easy to get subtly wrong: the signature scheme, the
micro-USDC formatting (never use floats for money — the ledger is integers), and the bundler
configuration. Subcommands are deliberately not exported; they call `process.exit`.

## The other Singularity CLIs

These are separate on purpose — different audiences, different runtimes.

| CLI | Who it's for |
|---|---|
| `singularity` | Developers building on the platform |
| [`sglcode`](https://www.npmjs.com/package/sglcode) | Agentic coding on the grid |
| `sgl` | Node operators running compute and earning |

New capabilities here become **subcommands**, never new binaries.
