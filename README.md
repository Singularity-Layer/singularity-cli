# `singularity` — Singularity developer CLI

Build on the Singularity Cloud Network from your terminal.

```bash
npm i -g @singularity-layer/cli
singularity --help
```

Requires Node 20+ (22+ for `sandbox connect`) and either a Solana keypair (`solana-keygen new`) or a compute API key. No
account and no dashboard login — your wallet *is* the account.

## Processors

A Processor is a loop you write; we host it, run it on demand, and buyers pay **you** directly per
call. There is no platform cut and we never custody your money: an x402 payment is a USDC transfer
from the buyer's wallet to yours. Buyers pay with the x402 `X-Payment` header (v1) or, where the 402
also carries a `PAYMENT-REQUIRED` header, `PAYMENT-SIGNATURE` (v2); it is the same transfer either way.

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

## Coding sandbox

Use your Coding sandbox (Claude Code, Codex, OpenCode or Pi on its own private computer) from your
own terminal. It is the same secure path the browser terminal uses: a single-use, 60-second ticket
and a WebSocket relayed through the sandbox's own outbound connection. No open port.

```bash
export SGL_API_KEY=x402c_...              # see Permissions below
singularity sandbox list
singularity sandbox connect               # a full shell, here. Type ~. on a new line to leave
singularity sandbox exec -- npm test      # one command; exits with its exit code
singularity sandbox files                 # list the workspace
singularity sandbox get src/app.ts        # print a file (or: get src/app.ts ./app.ts)
singularity sandbox put ./notes.md        # upload a text file (up to 100 KB)
singularity sandbox key                   # an OpenAI-compatible key for the sandbox's agent
```

A sleeping sandbox wakes by itself when you connect or run something. `connect` needs Node 22 or
newer (it uses the built-in WebSocket). With more than one sandbox, name it: its id, the first few
characters of the id, or its name (`singularity sandbox connect 99a7`).

**SSH, VS Code and Cursor** (0.6.0). Real SSH: `ssh`, `scp`, `sftp`, port forwarding, and VS Code
or Cursor Remote-SSH. There is no SSH port: this CLI is ssh's ProxyCommand.

```bash
singularity sandbox ssh-config <sandbox-id>   # key + a Host entry in ~/.ssh/config; prints the name
ssh sgl-my-sandbox                            # a shell as the sandbox user
scp ./data.csv sgl-my-sandbox:workspace/
ssh -L 3000:localhost:3000 sgl-my-sandbox
singularity sandbox ssh <sandbox-id> -- -L 3000:localhost:3000   # the same with no config
```

Each connection gets a single-use ticket bound to your public key (`~/.singularity/ssh/id_ed25519`,
made by `ssh-config`; the private half never leaves your machine), and the sandbox starts an SSH
server for that one connection that accepts only that key. No passwords; agent and X11 forwarding
off. Editors start ssh without your shell's environment, so `ssh-config` saves the API key it ran
with to `~/.singularity/credentials.json` (mode 600; only `ssh-proxy` reads it; `--no-save-key`
skips it). In VS Code / Cursor: Remote - SSH > Connect to Host, and set
`"remote.SSH.connectTimeout": 60` (a sleeping sandbox takes a few seconds to wake). An open
connection keeps the sandbox awake. `ssh-config <id> --remove` takes the entry out.

**OpenAI-compatible address.** `singularity sandbox key` prints a key and a base URL like
`https://compute.x402layer.cc/pods/<id>/v1`. Point any OpenAI client at it with model `agent-pod`;
each request is one turn of the sandbox's coding agent (streaming works). The agent can run commands
on the sandbox, so treat the key like a password. `keys` lists them, `revoke-key` turns one off.

Permissions: the terminal, SSH, exec, files and keys all need a compute API key (Settings > API keys)
with Compute "Extend, resize, destroy" (compute:write) and the Agent Pods permission "Read and write pod files, install skills, create and restore
backups" (`pods:control:write`), or a keypair. Keys from a Google, GitHub or X login can use `connect`, `key`
and `keys`; `exec`, `files`, `get` and `put` need a key from a wallet login.

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

Two ways in. The CLI picks the API key when one is given, and the keypair otherwise.

**Wallet signature (default).** Uses `~/.config/solana/id.json` (`--keypair <path>`,
`SINGULARITY_KEYPAIR`, or `singularity processors configure` to change it). **The key never leaves
your machine** — only a signature is sent, and it covers the method, the path and a hash of the
body, so it authorizes exactly one request and cannot be replayed against another.

**Compute API key.** `--api-key x402c_...`, or `SGL_API_KEY` in the environment. This is the option
for CI and for agents, where there is no keypair to hold.

```bash
export SGL_API_KEY=x402c_...
singularity whoami                  # the wallet the key resolves to
singularity processors list
singularity processors deploy
```

Mint the key in the dashboard with the `processors:write` scope, or `processors:read` if you only
need the read commands. Two things to know before you rely on it:

- **`processors:write` is full control** of that wallet's processors, delete and secrets included.
  A bearer credential cannot be bound to one request the way a signature is, so scope is the only
  control. Mint `processors:read` if you want something that cannot change anything.
- **`deploy` needs a key minted on a Solana wallet.** That address becomes your payout account, so
  a key on an EVM wallet gets `400 solana_wallet_required`. It can still manage processors its
  wallet already owns.

An API key never expires, and there is no audit log of what it did. Revoking it in the dashboard is
the only way to stop it.

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
