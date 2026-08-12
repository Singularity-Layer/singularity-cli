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

Values are write-only. They are never returned — not to you, not to your code — and the egress
gateway injects them into outbound requests to the host you bound them to.

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
