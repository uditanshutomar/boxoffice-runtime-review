# Lessons

Each lesson replaces one service's `app.js`. Build it with `make lesson LESSON=<name>` and inspect
the difference against `pkg/<service>/app.js`. The remaining services stay on baseline.

| Lesson | Service | Change | Expected runtime result |
| --- | --- | --- | --- |
| `swallow-errors` | storefront | Logs an inventory refusal and continues to pricing | A competing reservation receives 201 with no hold; conflict checks fail |
| `safe-refactor` | storefront | Extracts the same validation into a helper | The reservation contract and active-hold retries are unchanged; checks pass |
| `drop-fees` | pricing | Removes fees from the quote and total | Exact quote checks fail, even with a warm baseline cache |

Both the conventional guard and the hosted Smart Test cover these three lessons. Only baseline
and `safe-refactor` should pass. `drop-fees` is also useful for a later contract-diff tutorial.

For a PR demonstration, copy the lesson into `pkg/`, commit it on a branch, and build that actual
PR revision. Convenience lesson tags are for exploration, not proof of a PR head's contents.

Potential future lessons include enum changes, rounding, idempotency and cache keys. They do not
ship here yet. Add one only with a behavior test and a safe comparison. Static review may detect
any of them; the purpose is to provide reproducible runtime evidence, not to trick a reviewer.
