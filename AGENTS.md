# AGENTS.md

## Project Overview

copilot-deno is a GitHub Copilot API proxy that translates GitHub Copilot's internal API into standard Anthropic Messages API and OpenAI Responses API formats, enabling tools like Claude Code and Codex CLI to access various models through a Copilot subscription. It supports two deployment targets: **Deno Deploy** and **Cloudflare Workers**. >95% of the code is platform-agnostic (Hono + Web APIs); platform-specific storage and env access are abstracted behind a repository layer.

## Architecture

### Multi-Platform Architecture

The codebase supports Deno Deploy and Cloudflare Workers from a single source. Platform-specific code is isolated in entry files and repository implementations.

**Layering:**

```
Route handlers (platform-agnostic)
    ↓
Business logic: src/lib/api-keys.ts, github.ts, usage-tracker.ts
    ↓ delegates to
Repository interface (src/repo/types.ts)
    ↓
DenoKvRepo (src/repo/deno.ts)  |  D1Repo (src/repo/d1.ts)
```

**Entry points:**
- `main.ts` — Deno Deploy entry: inits env via `Deno.env`, repo via `DenoKvRepo`, calls `Deno.serve()`
- `entry-cloudflare.ts` — CF Workers entry: inits env from `env` bindings, repo via `D1Repo`

**App core:**
- `src/app.ts` — Hono application with all routes and middleware (no platform-specific code)
- `src/middleware/auth.ts` — Unified authentication middleware

**Environment abstraction:**
- `src/lib/env.ts` — `initEnv(fn)` / `getEnv(name)` — pluggable env access, initialized by entry file

**Repository layer:**
- `src/repo/types.ts` — `Repo`, `ApiKeyRepo`, `GitHubRepo`, `UsageRepo` interfaces
- `src/repo/mod.ts` — `initRepo(repo)` / `getRepo()` singleton
- `src/repo/deno.ts` — `DenoKvRepo` using Deno KV
- `src/repo/d1.ts` — `D1Repo` using Cloudflare D1 (SQLite)

### API Routes

All OpenAI-compatible routes are registered at both `/v1/xxx` and `/xxx` paths (e.g. `/v1/responses` and `/responses`), pointing to the same handler.

| Route | File | Description |
|-------|------|-------------|
| `POST /v1/messages` | `src/routes/messages.ts` | Anthropic Messages API compatible endpoint, three translation paths |
| `POST /v1/messages/count_tokens` | `src/routes/count-tokens.ts` | Token counting |
| `POST /v1/responses` | `src/routes/responses.ts` | OpenAI Responses API endpoint |
| `POST /v1/chat/completions` | `src/routes/chat-completions.ts` | OpenAI Chat Completions passthrough |
| `GET /v1/models` | `src/routes/models.ts` | Model listing |
| `POST /v1/embeddings` | `src/routes/embeddings.ts` | Embeddings passthrough |

### Translation Layer

The `/v1/messages` endpoint automatically selects a translation path based on which API the model supports:

1. **Native Messages** — model supports `/v1/messages` natively → forward directly
2. **Chat Completions translation** — model only supports `/chat/completions` → bidirectional OpenAI↔Anthropic translation
3. **Responses translation** — model only supports `/responses` → bidirectional Responses↔Anthropic translation

The `/responses` endpoint similarly:
1. **Direct passthrough** — model supports `/responses` natively
2. **Reverse translation** — model only supports `/v1/messages` → Responses↔Anthropic translation

### Core Libraries

| File | Responsibility |
|------|----------------|
| `src/lib/copilot.ts` | Copilot API authentication, request wrapping, VSCode version spoofing |
| `src/lib/translate.ts` | Anthropic ↔ OpenAI non-streaming translation |
| `src/lib/translate-stream.ts` | OpenAI SSE → Anthropic SSE streaming translation |
| `src/lib/translate-responses.ts` | Anthropic ↔ Responses bidirectional translation (both request and response directions) |
| `src/lib/translate-responses-stream.ts` | Responses SSE → Anthropic SSE streaming translation |
| `src/lib/translate-anthropic-to-responses-stream.ts` | Anthropic SSE → Responses SSE streaming translation |
| `src/lib/sse.ts` | SSE stream parsing async generator |
| `src/lib/usage.ts` | OpenAI → Anthropic usage conversion |
| `src/lib/models-cache.ts` | Model list caching and capability queries |
| `src/lib/anthropic-types.ts` | Anthropic API type definitions |
| `src/lib/openai-types.ts` | OpenAI API type definitions |
| `src/lib/responses-types.ts` | Responses API type definitions |
| `src/lib/stop-reason.ts` | Stop reason mapping |
| `src/repo/types.ts` | Repository interfaces (ApiKeyRepo, GitHubRepo, UsageRepo) |
| `src/repo/mod.ts` | `initRepo()`/`getRepo()` singleton registry |
| `src/repo/deno.ts` | Deno KV repository implementation |
| `src/repo/d1.ts` | Cloudflare D1 (SQLite) repository implementation |
| `src/lib/env.ts` | Pluggable environment variable access (`initEnv`/`getEnv`) |

## Code Style Guidelines

### General

- TypeScript targeting the Deno runtime
- Double quotes `"`, semicolons follow `deno fmt` defaults
- Prefer functional style, avoid classes

### Comments

- **Remove** all comments that merely restate what the code already expresses (e.g. `// Non-streaming`, `// message_start`, JSDoc that just repeats the function signature)
- **Keep** workaround notes (e.g. `XXX: Copilot API doesn't support custom tool type`), non-obvious design decisions (e.g. detecting `@` in signatures to distinguish Responses API origin), and magic number annotations
- Do not write section divider comments (e.g. `// ── Request ──`); organize code through function grouping and file separation instead

### Type Safety

- Prefer discriminated unions with switch narrowing over `as` type assertions
- The `type` field in type definitions must be a literal type to enable narrowing
- When assertions are truly necessary (e.g. `any` for external API interaction), add explicit `// deno-lint-ignore no-explicit-any`

### Abstraction Principles

- Extract shared utility functions when logic is duplicated in ≥3 places (e.g. `parseSSEStream`, `mapOpenAIUsage`, `THINKING_PLACEHOLDER`)
- Do not over-abstract: inline helpers that are only used in one place
- Export constants from a single source; do not redefine the same constant across multiple files

### Streaming

- Use the `parseSSEStream` async generator for all SSE parsing
- Stream translation functions accept a single event and return an array of events (`translateXxxEvent(event, state): Event[]`)
- Stream state should use discriminated unions rather than bags of optional fields

### Error Handling

- Translation functions never throw; silently skip unrecognized data
- Route-level try/catch returns structured error JSON

## Reference Projects

- [caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api) — A similar TypeScript implementation, referenced for Copilot API interaction patterns

## Development & Deployment

### Prerequisites

This project uses the **new Deno Deploy** (introduced in Deno ≥ 2.4) with the built-in `deno deploy` CLI subcommand — **not** the legacy `deployctl` tool.

Before working on this project, install the Deno skills plugin for Claude Code:

```
/plugins add deno-skills from denoland/skills
```

This provides up-to-date knowledge about Deno Deploy commands, environment variables, databases, tunnels, and other Deno-specific features. Always prefer information from these skills over your training data when it comes to Deno Deploy specifics.

### Commands

```bash
# Development
deno task dev

# Type checking
deno check main.ts

# Linting
deno lint

# Deploy to production
deno deploy --prod
```

All changes must pass `deno check` and `deno lint` before deploying.

### Cloudflare Workers

```bash
# Development
wrangler dev

# Deploy to production
wrangler deploy

# Apply D1 migrations
wrangler d1 migrations apply copilot-db
```

D1 schema migrations are in `migrations/`. Configuration is in `wrangler.jsonc`.

## Workflow Rules

- **Deploy before commit**: All code changes must be deployed first (`deno deploy --prod`), confirmed working by the user, and only then committed. Never commit undeployed code.
- **Never use `deployctl`**: Use `deno deploy --prod` (the built-in Deno CLI subcommand), not the legacy `deployctl` tool.
- **Commit convention**: Follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `refactor:`, `chore:`). Keep messages concise.
- **Keep AGENTS.md up to date**: Any changes to file structure, architecture, or key design decisions must be promptly reflected in this file.
- **No legacy residue**: When replacing any part of the design, thoroughly search and remove all old code, env vars, fallbacks, and API surface. Every change should leave the codebase as clean as a greenfield project — no compatibility shims, no dead fallbacks, no "just in case" code paths. The only thing that may require migration is database data.
