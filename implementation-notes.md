# Implementation notes — workstream D

## Deviations

- (spec) read keeps #62 loop as fitReadEnvelope instead of capEnvelope — link-shrink semantics; applied to decoder path too (grok P0-1).
- (plan Task 5) removed eager no-progress break in capEnvelope loop — escalating budget shave is the progress mechanism; plateau cases previously overshot ~6% under indented serializer, violating spec hard-cap intent. Also deduped mergeInfo note. Implementer-flagged, controller-approved.
- (plan Task 5, round 2) fixed-shave loop → bisection on measured serialized bytes; reviewer C1 proved plan algorithm porous under indent (+42% flat array). Floor-first fallback, best-fit ≤8 rounds.
- (Task 6) handleBrowse's `--json` guidance branch (BrowseGuidance, `success: false`) has no bulk `data` field, so full `capEnvelope` bisection is unnecessary there — used the same placeholder-then-patch trick directly (measure `{...result, envelopeBytes: 999_999_999}`, patch real value in) without invoking `capEnvelope`. `envelopeBytes` is still always present on browse `--json` output, per brief interface note, for both success and guidance shapes. No plan deviation from Task 6 brief itself — brief only showed the replay wiring in detail and left browse as "same pattern"; this is the natural adaptation for its two-variant result type.
