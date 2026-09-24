# System One extension

This package owns the complete System One feature for Forage. It is an ordinary, independently activated Forage extension: installing workspace dependencies does not register, trust, enable, configure, or select it.

The package depends at runtime only on `@forage/extension-api`. It declares one generic `System One` executor and device-local `typesafe_api_key` secret. Choice comparison/classification, Score rubrics, Noul definitions and filtering, candidate selection, TypeSafe Jev transport, answer validation, ordering, and ordinary linked output all stay here. Forage core sees only the generic executor contract.

The adapter calls `POST https://api.typesafe.ai/v1/systemone` directly and makes exactly one request per execution. Candidate-specific questions sharing state are batched in that request; comparative Choice always contains the complete prepared candidate set. Oversized expansions fail before fetch and are never truncated or partitioned. HTTP or network failures are not retried automatically.

Results are either an ordinary linked list under the question or, with **Output: Reorder the bullets in place**, a host-applied permutation of the direct sibling candidates in numeric order. Reordering writes no bullets, keeps every Noul candidate (the threshold does not apply), and reports each candidate's answer in run activity. In descendants scope, each nested candidate is judged with its parent bullets inside the scope and its direct children as evidence.

Choice and Score probability distributions must contain exactly the requested keys, use finite values from zero to one, and sum to one within `0.001` plus the rounding error of TypeSafe's two-decimal values (`0.005` per option). Score values must also match the probability-weighted level index within `0.001` plus `0.005` for the score and for each level index step, because TypeSafe rounds both the score and every probability. Noul returns only its yes probability and never invents confidence.

Offline checks use mocked fetch and synthetic credentials only:

```bash
pnpm --filter @forage/extension-system-one build
pnpm --filter @forage/extension-system-one typecheck
pnpm --filter @forage/extension-system-one test
```

For local development, build the package, register this directory in Extensions settings, review trust, configure the TypeSafe secret, enable it, and explicitly choose `System One` in a user-created skill. The extension never installs a command or skill of its own.
