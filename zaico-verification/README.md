# zaico-verification/

One-time, read-only reconnaissance for the ZAICO→BELLO sync's field
mapping (`lib/inventory/zaicoMapping.ts`, not written yet). This is not
part of the BELLO app — it's a throwaway script whose entire job is to
fetch a few real ZAICO API responses so that mapping can be built from
actual field names/types instead of a guess, per explicit instruction.

**Only ever issues GET requests.** There is no POST/PUT/PATCH/DELETE
code path in `fetchSamples.mjs` — nothing here can write to ZAICO.

## Why this has to run on your machine, not here

This Claude Code session's outbound network access does not resolve
`api.zaico.co.jp` or `developer.zaico.co.jp` at all, and no ZAICO API
token exists anywhere in this repository or session. Both are required
to fetch anything from ZAICO, so this script has to run somewhere that
has your ZAICO API token and real internet access — your Windows
machine.

## Running it

```powershell
cd C:\Users\win\Documents\GitHub\aws-amplify-system
$env:ZAICO_API_TOKEN = "<your ZAICO API token>"
node zaico-verification/fetchSamples.mjs
```

Requires Node.js (any version with built-in `fetch`, i.e. 18+ — the
same Node this project already needs for `npm run dev`). If you already
have `ZAICO_API_TOKEN` set some other way (a prior `zaico-verification/`
setup, a saved PowerShell profile variable, etc.), reusing that is fine
— the script just reads whatever is in the environment.

Optional overrides, only if the default guessed base URL turns out to
be wrong (see "What it actually does" below):

```powershell
$env:ZAICO_API_BASE_URL = "https://web.zaico.co.jp/api/v1"   # default
$env:ZAICO_SAMPLE_INVENTORY_ID = "73638418"                  # default
```

## What it actually does

Fetches three things and saves each response (JSON, pretty-printed) to
`zaico-verification/output/` — never prints a large response to the
terminal, never writes the token or `Authorization` header to any file:

- `inventory-detail.json` — `GET {base}/inventories/{id}` for the known
  sample ID.
- `inventory-list-sample.json` — `GET {base}/inventories?limit=5`, a
  small page of the list endpoint (list and detail responses may not
  share the same shape).
- `inventory-attachments.json` (or `.txt` if the response isn't JSON) —
  `GET {base}/inventories/{id}/attachments`. This endpoint path is a
  guess (attachments/images are commonly a separate sub-resource); a 404
  here is still useful information — it means the image URL is probably
  inline on the inventory detail response instead, which the first file
  will show either way.

A light redaction pass replaces the *value* of any key that looks like
personal information (name/phone/email/address, English or Japanese)
with `"[REDACTED]"` before saving — key names are always kept, since
discovering the real key names is the entire point. This is a
best-effort safety net for what's expected to be a furniture/product
inventory, not a guarantee; skim the saved files yourself before
sharing them further if anything looks off.

## After running it

`zaico-verification/output/` is gitignored — it never gets committed.
Paste the contents of the saved file(s) back into the conversation (or
attach them) so the actual ZAICO→BELLO field mapping can be built from
real data, per the project's explicit "don't implement the mapping from
a guess" requirement.
