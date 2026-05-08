# Notion → GitHub Logic App

Azure Logic App that receives Notion webhook events and dispatches a `repository_dispatch` to the right consumer repo.

## Files

- `workflow.json` — full Logic App workflow definition. Paste into the Logic App's "Code view" (Designer → ⋯ → Code view), or deploy via ARM template wrapping.
- `parameters.template.json` — placeholder shape for the workflow parameters. Fill in real values in the Azure Portal, **not** in a committed file.

## Routing model

The webhook payload only includes `workspace_id` (shared across all teamspaces in a Notion workspace) and `entity.id` (the page/database that changed). Teamspace ID is **not** in the payload, and Notion's API doesn't expose teamspace membership on page objects.

To route correctly, the Logic App walks up the parent chain via `GET /v1/pages/{id}` (or `/databases/{id}`) until it hits an ID that matches a known **rootPageId** (each project's Notion Project Home page). That rootPageId maps to a `(owner, repo)` pair, and the dispatch goes there.

The mapping is keyed by **dash-stripped, lowercase** rootPageId (the workflow normalizes both sides before lookup).

## Setting parameters in Azure

In the Logic App resource → **Parameters** blade:

| Name | Type | Source |
|---|---|---|
| `notionToken` | SecureString | Notion integration token (rotate any value that has been pasted in chat or committed) |
| `githubToken` | SecureString | GitHub fine-grained PAT with `Contents: read` and `metadata: read` scopes plus `repository_dispatch` write on each consumer repo |
| `notionVersion` | String | `2026-03-11` |
| `dispatchEventType` | String | `notion-changed` (matches the consumer workflows' `repository_dispatch.types`) |
| `repoMapping` | Object | See `parameters.template.json` |

For production hardening, swap the secret strings for Key Vault references via a Managed Identity on the Logic App.

## Adding a new project

1. Get the new project's Project Home page UUID from `.volt/.volt-sync.yml` → `notion.rootPageId`.
2. Strip dashes, lowercase: `2e03acdc-7e9b-8037-...` → `2e03acdc7e9b80370...`.
3. Add the entry to `repoMapping` in the Azure Portal's Parameters blade.
4. Save. No redeploy needed.

## Verification token echo

Notion's webhook setup flow expects a `verification_token` echo on the first POST. The first action in the workflow checks for `triggerBody().verification_token` — if present, the body is echoed back unchanged and the run terminates without walking parents. This branch is the standard Notion webhook handshake.

## Local validation

Once deployed, you can hit the trigger URL with curl using a sample payload:

```bash
curl -X POST "$LOGIC_APP_TRIGGER_URL" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "page.created",
    "entity": { "id": "<some-page-uuid-inside-a-known-project>", "type": "page" }
  }'
```

A successful run responds with `{ "status": "dispatched", "repo": {...}, "iterations": N }`. An unrecognized page responds `{ "status": "no_match", ... }` with HTTP 200 (so Notion doesn't retry).
