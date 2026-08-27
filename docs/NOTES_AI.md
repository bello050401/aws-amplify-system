# AI (Anthropic) — implementation notes

This system talks to Claude through a single abstraction (`lib/ai/`), so
provider-specific quirks stay in `lib/ai/anthropic.ts` / `lib/ai/openai.ts`
— nothing else in the app touches the Anthropic/OpenAI wire format directly.

## `invalid_request_error` on 「特集を生成」(fixed)

**Symptom:** once `ANTHROPIC_API_KEY` was set, generating a feature failed
with an `invalid_request_error` from the Anthropic API instead of the
earlier "key not set" error.

**Root cause:** `@anthropic-ai/sdk` was pinned to `^0.32.0` (released
~Nov 2024, over a year stale), while `ANTHROPIC_MODEL` defaults to
`claude-sonnet-5` — a current-generation model whose request surface moved
on from what that SDK/era assumed. Concretely, on Claude Sonnet 5 (unlike
Sonnet 4.6 and older):

- Omitting `thinking` entirely no longer means "no thinking" — it now runs
  **adaptive extended thinking by default**. Thinking tokens count against
  `max_tokens` together with the actual output, so a `max_tokens` sized
  only for "the JSON/text we expect" (this code used 2000 / 500) can now
  get eaten into by thinking spend.
- `thinking: {type: "enabled", budget_tokens: N}` (the older fixed-budget
  shape) is rejected outright on this model family — not used here, but
  worth knowing if it ever gets added back by habit.
- Non-default `temperature`/`top_p`/`top_k` are rejected — also not used
  here.

**Fix (`lib/ai/anthropic.ts`):**
- Bumped `@anthropic-ai/sdk` to `^0.121.0`.
- Set `thinking: { type: "adaptive" }` explicitly on both calls, instead of
  relying on whatever a given model's default happens to be, plus
  `output_config: { effort: "medium" }` (full generation) / `"low"`
  (single-field regeneration) to keep cost down — copywriting doesn't need
  deep reasoning. (Disabling thinking outright was deliberately avoided:
  with thinking off, a model can occasionally emit a forced tool call as
  plain text instead of a real `tool_use` block, which is worse for this
  code path than a bit of adaptive-thinking spend.)
- Raised `max_tokens` (2000→4000, 500→1500) to give that thinking spend
  headroom on top of the actual copy/JSON output.
- Wrapped both `messages.create()` calls in try/catch that logs the full
  error server-side and rethrows a message that includes the Anthropic
  `request_id` (never the API key) — the admin UI already shows
  `err.message` as-is, so this makes the *next* API-side error (whatever
  it turns out to be) traceable without guessing.

## Why prompt caching (`cache_control`) is not used here

Every generation call has a **unique** user prompt — a different,
freshly-selected set of BASE items each time — immediately after a short
system prompt + one tool schema (well under Anthropic's ~1024–4096 token
minimum cacheable prefix, which varies by model). There's no repeated
prefix across calls for a cache to serve, so adding `cache_control` here
would only add cache-write overhead for reads that would never happen.
Revisit this only if a single system prompt/tool set ends up reused across
a high volume of generations (e.g. a Phase 2 batch/regeneration job).

## Where each item plugs in

| Concern | File |
|---|---|
| Anthropic request construction, thinking/effort, error messages | `lib/ai/anthropic.ts` |
| OpenAI (secondary provider) request construction | `lib/ai/openai.ts` |
| Provider-agnostic prompt text / guardrails | `lib/ai/prompt.ts` |
| Provider selection (`AI_PROVIDER` env var) | `lib/ai/index.ts` |
