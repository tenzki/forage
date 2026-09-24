# System One extension

This package owns the complete System One feature for Forage. It is an ordinary, independently activated Forage extension: installing workspace dependencies does not register, trust, enable, configure, or select it.

The package depends at runtime only on `@forage/extension-api`. It declares one generic `System One` executor and device-local `typesafe_api_key` secret. Choice comparison/classification, Score rubrics, Noul definitions and filtering, candidate selection, TypeSafe Jev transport, answer validation, ordering, and ordinary linked output all stay here. Forage core sees only the generic executor contract.

The adapter calls `POST https://api.typesafe.ai/v1/systemone` directly and makes exactly one request per execution. Candidate-specific questions sharing state are batched in that request; comparative Choice always contains the complete prepared candidate set. Oversized expansions fail before fetch and are never truncated or partitioned. HTTP or network failures are not retried automatically.

Each skill stores a rubric (question type, levels or categories, Noul definitions and threshold). The text typed after the command is the question; the configured question is only a default used when nothing is typed, and a run with neither fails before any request.

List results use one line per candidate: a link plus at most one short value (★ for the selected comparison candidate, the nearest level label for Score). Classification groups links under category bullets in configured order, and Noul lists only matching links. Probabilities, scores and confidence are written to each row's bullet note. Rows sit directly under a typed question; a default question becomes the heading bullet. Comparison, Score and Noul are ordered highest first.

Results are either that ordinary linked list or, with **Output: Reorder the bullets in place**, a host-applied permutation of the direct sibling candidates in result order. Reordering writes no bullets, keeps every Noul candidate (the threshold does not apply), and reports each candidate's answer in run activity. With **Output: Tag the bullets in place**, classification appends each candidate's category tag (the label as a tag, e.g. `Build later` → `#build-later`, unless a tag is set) and Noul appends its configured tag to candidates at or above the threshold. Each run removes the skill's other tags, so rerunning replaces the previous answer. A classification's optional minimum probability applies to every output: uncertain candidates are listed under a final **Unclassified** group with their best guess, moved last when reordering, and left untagged. Score and comparison have no tag output. In descendants scope, each nested candidate is judged with its parent bullets inside the scope and its direct children as evidence.

Choice and Score probability distributions must contain exactly the requested keys, use finite values from zero to one, and sum to one within `0.001` plus the rounding error of TypeSafe's two-decimal values (`0.005` per option). Score values must also match the probability-weighted level index within `0.001` plus `0.005` for the score and for each level index step, because TypeSafe rounds both the score and every probability. Noul returns only its yes probability and never invents confidence.

Offline checks use mocked fetch and synthetic credentials only:

```bash
pnpm --filter @forage/extension-system-one build
pnpm --filter @forage/extension-system-one typecheck
pnpm --filter @forage/extension-system-one test
```

For local development, build the package, register this directory in Extensions settings, review trust, configure the TypeSafe secret, enable it, and explicitly choose `System One` in a user-created skill. The extension never installs a command or skill of its own.
