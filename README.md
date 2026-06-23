# OpenAPI sync plugin for Yaak

Yaak plugin that compares the active workspace with a remote OpenAPI document and applies selected endpoint changes.

## What it does

- Adds a workspace action: `Sync with OpenAPI...`
- Fetches an OpenAPI spec from a remote URL
- Converts the spec into Yaak HTTP request resources
- Compares endpoints against the current workspace by normalized `METHOD + path`
- Detects missing URL parameters on matching requests
- Shows a review dialog before applying changes

## Review behavior

- The compare dialog always opens, even when there are no changes
- Additions, deletions, and parameter updates are sorted by `path`, then `method`
- Checkbox rows use skip semantics:
  - `Skip /path [METHOD]` under additions means leave it unchecked to add the request
  - `/path [METHOD]` under deletions means check it to delete that request
  - `Skip /path [METHOD] (+N params)` under parameter updates means check it to avoid adding those missing parameters
- If no changes are found, the dialog still shows the result and no apply step is performed

## Scope

- Syncs HTTP endpoints only
- Detects:
  - endpoint additions
  - endpoint deletions
  - missing path/query parameters on existing matching requests
- Parameter sync is additive only:
  - existing parameter values are preserved
  - existing parameters are not removed
  - existing parameters are not overwritten
- Does not sync field-level request edits yet
- Does not sync GraphQL, gRPC, or WebSocket resources

## Notes

- The plugin uses Yaak's HTTP request API to fetch the remote spec
- Folder structure is created only as needed for selected additions
- The last entered OpenAPI URL is stored in plugin storage and used as the next default
- Matching is done by normalized `METHOD + path`, so host differences do not create separate endpoints
