# Sanitized raw parser contracts

These envelopes are copied from the existing API samples. Message text, reasoning,
artifact text, titles, owner identifiers, Gemini IDs and suggestions are replaced with
synthetic fixture values. Shape, nulls, metadata positions and provider type tags
are retained. No production archive is read.

Add a sanitized complete `RawCapture` envelope as `<name>.json` in this directory.
`bun test test/contract.test.ts` discovers every JSON envelope and requires at
least one per provider. Each must yield messages with zero unknown blocks.

For a deliberately retained unknown, add `<name>.allowlist.json` containing an
array of exact `provider_type` strings. For example:

```json
["future_widget"]
```

Only explicitly listed types are allowed. Sanitize all chat text, titles, account
identifiers, endpoints, URLs, asset pointers and opaque payloads before checking
in a capture. Preserve the structure that the parser needs.
