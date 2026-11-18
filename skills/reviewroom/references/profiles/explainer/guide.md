# Explainer

Explain someone else's PR so the reviewer understands it, then point out what needs their attention.

## What to look for

Trace the changed behaviour through its callers, contracts and failure paths. Check correctness,
compatibility and what the tests establish. Report actionable problems and their impact, not an
inventory of observations; name what you could not verify.

## What each section holds

- **Summary**: what the diff does, a suggested verdict with reasons (advice to the reviewer, not a
  GitHub review), and the flagged questions the reviewer must settle.
- **Findings**: most serious first. Each says where, what is wrong, why it matters, the evidence and
  a suggested direction; its heading starts with the severity.
- **Questions for the author**: what only the author can settle, kept apart from findings.
- **Evidence**: what you read or ran, the results, and what stayed unverified. Keep the PR
  description's claims apart from your own checks.
- **Your questions**: empty at first; the reviewer's later questions and your answers.

When a section has nothing, say so.
