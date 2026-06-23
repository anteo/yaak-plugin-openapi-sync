# OpenAPI sync plugin for Yaak

Yaak plugin that compares the active workspace with a remote OpenAPI document and applies selected endpoint additions or deletions.

## What it does

- Adds a workspace action: `Sync with OpenAPI...`
- Fetches an OpenAPI spec from a remote URL
- Converts the spec into Yaak HTTP request resources
- Compares endpoints against the current workspace by normalized `METHOD + path`
- Shows a review dialog before applying changes

## Review behavior

- The compare dialog always opens, even when there are no changes
- Additions and deletions are sorted by `path`, then `method`
- Checkbox rows use skip semantics:
  - `Skip /path [METHOD]` under additions means leave it unchecked to add the request
  - `Skip /path [METHOD]` under deletions means check it to avoid deleting that request
- If no changes are found, the dialog shows the result and closes without applying anything

## Scope

- Syncs HTTP endpoints only
- Detects endpoint presence changes only
- Does not sync field-level request edits yet
- Does not sync GraphQL, gRPC, or WebSocket resources

## Notes

- The plugin uses Yaak's HTTP request API to fetch the remote spec
- Folder structure is created only as needed for selected additions
- The last entered OpenAPI URL is stored in plugin storage and used as the next default
