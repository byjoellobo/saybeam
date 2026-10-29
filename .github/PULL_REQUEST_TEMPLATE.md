## Summary

<!-- What does this change, and why? A few plain sentences are plenty. -->

## Linked issue

<!-- For example: Closes #123. If there is no issue, say why the change is needed. -->

## How I tested it

<!-- Commands you ran, devices and browsers you tried, screenshots for UI changes. -->

## Checklist

- [ ] Tests added or updated for the change.
- [ ] `npm run lint && npm run typecheck && npm test` passes.
- [ ] Relay changes: `npm run test:relay` passes.
- [ ] Protocol changes: `docs/protocol.md`, `packages/protocol/src/room-core.ts` and the Rust relay are updated together, and `npm run conformance -- <baseUrl>` passes against both `wrangler dev` (port 8787) and the relay (port 7300).
- [ ] UI changes: checked with a keyboard and a screen reader, at large text sizes, and in the high-contrast themes.
- [ ] No em dash characters in code, docs or UI copy.
- [ ] Every commit is signed off (`git commit -s`) under the [DCO](https://developercertificate.org/).
