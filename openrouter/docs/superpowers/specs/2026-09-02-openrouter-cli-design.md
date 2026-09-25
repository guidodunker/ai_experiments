# OpenRouter CLI — Design

**Date:** 2026-09-02
**Status:** Approved

## Purpose

A one-shot terminal command that sends a prompt to a model through
[OpenRouter](https://openrouter.ai) and streams the reply to stdout.

This is a learning project. Its success criterion is not features but
understanding: after building it, the author should know what an OpenRouter
chat-completion request looks like on the wire, how its Server-Sent Events
stream is framed, and what a call costs. Every design decision below favors
visible mechanics over convenience, and minimal code over generality.

## Scope

In scope:

- One prompt per invocation, passed as a command-line argument.
- Streamed output, decoded from raw SSE.
- Token and cost accounting printed after the answer.
- A single hardcoded model.

Explicitly out of scope (YAGNI for a learning project):

- Interactive REPL or conversation history.
- Model selection via flag or environment variable.
- Retries, fallbacks, or provider routing preferences.
- Tool calling, images, or structured output.
- An automated test suite. Verification is a manual smoke run; see
  *Verification*.

## Usage

```
npm start -- "explain TCP in one line"
```

The prompt is `process.argv[2]`. Anything after it is ignored.

## Toolchain

No runtime dependencies. Node 22.14 provides everything needed:

- **Global `fetch`** — stable since Node 18, so no HTTP client dependency.
- **`--experimental-strip-types`** — runs `.ts` files directly by erasing type
  annotations. No build step, no `dist/`, no `tsx`.
- **`--env-file-if-exists=.env`** — loads the API key without a `dotenv`
  dependency. The `-if-exists` variant is deliberate: plain `--env-file` makes
  Node abort with exit 9 when the file is missing, which would preempt the
  friendly "set OPENROUTER_API_KEY" message on a fresh clone.
- **`--disable-warning=ExperimentalWarning`** — suppresses the type-stripping
  notice so stderr carries only our own output.

Dev dependencies are `typescript` (for `npm run typecheck` and editor support;
it never emits) and `@types/node`, pinned to `^22` to match the Node 22
runtime rather than tracking the latest major.

**Windows caveat:** `.env` must be saved **without a UTF-8 BOM**. Node's
env-file parser treats a leading BOM as part of the first variable's name, so
`OPENROUTER_API_KEY` silently reads as undefined. PowerShell's
`Set-Content -Encoding utf8` writes a BOM on Windows PowerShell 5.1; copying
`.env` avoids the problem.

### Constraints this imposes

Node's type-stripper erases types; it does not compile. Syntax that needs code
generation is therefore illegal, and `tsconfig.json` must reject it at
typecheck time rather than letting it fail at runtime:

- `"erasableSyntaxOnly": true` — bans `enum`, `namespace` with runtime output,
  and constructor parameter properties.
- `"verbatimModuleSyntax": true` — forces `import type` for type-only imports,
  which the stripper cannot otherwise distinguish from value imports.
- `"allowImportingTsExtensions": true` with `"noEmit": true` — relative imports
  must be written as `./sse.ts`, because Node's resolver does not remap
  extensions.
- `"module": "nodenext"`, `"target": "es2023"`, `"strict": true`.

`package.json` sets `"type": "module"`.

## File layout

```
openrouter/
├── .env                 # OPENROUTER_API_KEY=sk-or-...   (gitignored)
├── .env.example         # committed template
├── .gitignore
├── package.json
├── tsconfig.json
├── docs/superpowers/specs/
└── src/
    ├── main.ts          # CLI entry
    ├── openrouter.ts    # chat-completion client
    ├── sse.ts           # SSE decoder
    └── types.ts         # API shapes
```

## Modules

Four files, each with one responsibility and an interface that can be
understood without reading its internals.

### `src/types.ts`

Hand-written declarations of the request body, the streamed chunk, the usage
record, and the error envelope. Type-only exports; no runtime code.

Writing these by hand rather than importing an SDK's types is deliberate — it
is the part of the exercise that forces the author to read the API reference.

### `src/sse.ts`

```ts
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string>
```

Decodes a Server-Sent Events body into its `data:` payloads as strings. Knows
nothing about OpenRouter, JSON, or chat completions. Depends only on
`TextDecoder`.

It exists as a separate module because SSE framing has three failure modes that
are easy to get wrong inline:

1. **Chunk boundaries are not event boundaries.** A network read can split an
   event in half or deliver three events at once. The decoder accumulates into a
   buffer and splits on the `\n\n` event separator, retaining any incomplete
   remainder for the next read.
2. **Comment lines.** OpenRouter sends `: OPENROUTER PROCESSING` keepalives
   while a model cold-starts. Lines beginning with `:` are comments per the SSE
   spec and must be skipped, not parsed as JSON.
3. **The terminator.** The stream ends with the literal payload `[DONE]`, which
   is not JSON. `parseSSE` yields it like any other payload; recognizing it is
   the caller's job, since it is a chat-completions convention rather than an
   SSE one.

### `src/openrouter.ts`

```ts
export const MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free'

export async function* streamChat(
  prompt: string,
  apiKey: string,
): AsyncGenerator<Delta>
```

The API key is passed in rather than read from `process.env` here, so that
`main.ts` remains the only module that touches `process` for input.

Owns everything OpenRouter-specific:

- `POST https://openrouter.ai/api/v1/chat/completions`
- Headers: `Authorization: Bearer $OPENROUTER_API_KEY`,
  `Content-Type: application/json`.
- Body: `{ model: MODEL, messages: [{ role: 'user', content: prompt }],
  stream: true, usage: { include: true } }`
- Throws on a non-2xx response, after reading the body for the server's own
  error message.
- Consumes `parseSSE`, stops at `[DONE]`, and yields a small tagged union:
  `{ kind: 'text', text: string }` for content deltas, and
  `{ kind: 'usage', usage: Usage }` for the final accounting chunk.

The tagged union is what keeps `main.ts` free of API knowledge: `main` decides
where each kind of output goes, without knowing the JSON path it came from.

Changing the model means editing the `MODEL` constant. The default is a `:free`
slug so experimenting costs nothing; any slug from
<https://openrouter.ai/models> works. Free models are rate-limited and can be
slower to first token, which makes the streaming behavior easier to observe.

### `src/main.ts`

The CLI shell, and the only module that touches `process`. It reads `argv` and
`env`, validates both, iterates `streamChat`, writes text deltas to stdout as
they arrive, prints the usage summary to stderr, and maps every failure to an
exit code.

## Data flow

```
argv[2] ──▶ main.ts ──▶ streamChat(prompt)
                             │
                             ├─▶ POST /api/v1/chat/completions
                             │      stream: true, usage: { include: true }
                             │
                             └─▶ res.body ─▶ parseSSE ─▶ "data:" payloads
                                                  │
                                            JSON.parse
                                                  │
                              ┌───────────────────┴───────────────────┐
                              │                                       │
                    choices[0].delta.content                        usage
                              │                                       │
                     { kind: 'text' }                        { kind: 'usage' }
                              │                                       │
              main: stdout.write(text)              main: stderr summary line
```

## Output discipline

The answer goes to **stdout**; everything else goes to **stderr**. So
`npm start -- "..." > answer.txt` captures the answer and nothing else.

- Text deltas are written with `process.stdout.write` — no newline between
  chunks. A single trailing newline is written once the stream ends.
- The usage summary is one stderr line after the answer, for example:
  `[nvidia/nemotron-3-ultra-550b-a55b:free] 14 prompt + 22 completion = 36 tokens, $0.000000`
- Token counts come from the final chunk's `usage` object; the cost is its
  `cost` field, which OpenRouter reports in credits (1 credit = 1 USD) and is
  the actual charged amount, not an estimate.
- If the stream ends without a usage chunk, the summary is skipped silently.
  It is diagnostic output, not a reason to fail a successful answer.

## Error handling

| Situation | Behavior | Exit |
|---|---|---|
| No prompt argument | `usage: npm start -- "<prompt>"` to stderr | 2 |
| `OPENROUTER_API_KEY` unset or empty | Message naming the variable and `.env` | 2 |
| Non-2xx response | HTTP status plus the server's `error.message` (401 invalid key, 402 insufficient credits, 429 rate limited) | 1 |
| Response has no body | "empty response body" | 1 |
| A single SSE payload fails `JSON.parse` | Skip that event, note it on stderr, keep streaming | 0 if the rest succeeds |
| Connection drops mid-stream | Partial answer on stdout is kept; error to stderr | 1 |

Two principles behind that table:

- **Distinguish user error from system error.** Exit 2 means the invocation was
  wrong and no request was attempted; exit 1 means the request was attempted
  and failed. A shell script can tell those apart.
- **Surface the server's own words.** OpenRouter returns
  `{ error: { message, code } }`. Printing a generic "request failed" while
  holding a body that says "insufficient credits" wastes the author's time.

`main.ts` wraps its work in a single `try`/`catch`; the modules throw plain
`Error` objects with useful messages rather than defining a custom hierarchy.

## Verification

No automated tests, by decision — the parser is the only nontrivial logic and
the project is a scratch experiment. Verification is a manual smoke run:

1. `npm run typecheck` reports no errors.
2. `npm start` with no argument prints usage and exits 2.
3. `npm start -- "hi"` with `OPENROUTER_API_KEY` unset exits 2 naming the
   variable.
4. `npm start -- "hi"` with a deliberately invalid key prints the 401 message
   from OpenRouter and exits 1.
5. `npm start -- "count from 1 to 20 slowly"` renders visibly incrementally,
   confirming the stream is not buffered to completion first.
6. `npm start -- "hi" > out.txt` leaves `out.txt` containing only the answer,
   with the usage line on the terminal.

If the SSE parser later needs regression coverage, the seam is `parseSSE`: it
takes a `ReadableStream` and returns strings, so `node:test` plus a
`ReadableStream.from` fixture is sufficient, with no network and no API key.
