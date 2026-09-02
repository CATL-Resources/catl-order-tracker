# Engineering Standards

Applies to every Claude session in this repo and every pull request. The owner does not read code, so the code has to prove itself. These rules are how it does that.

**The one rule:** nothing merges unless the automatic checks are green, and no check is trusted until it has been seen failing on purpose.

---

## 1. The gates

Every pull request and every push to `main` runs these automatically in GitHub Actions (`.github/workflows/ci.yml`). Nobody has to remember to run them. The exact commands for this repo are in `CLAUDE.md`.

| Gate | What it catches | Plain-English meaning |
|---|---|---|
| Typecheck | Calls to things that don't exist, wrong data shapes, renamed columns nobody told the screen about | "Does every piece fit the piece next to it?" |
| Lint | Sloppy or suspicious code patterns before they become habits | "Is it written the way this repo writes things?" |
| Tests | Rules and math that used to be right and now aren't | "Do the things we already proved still hold?" |
| Build | Anything that would stop the app from compiling and deploying | "Can this actually ship?" |
| PR summary check | A pull request without the four-section summary (section 3) | "Can the owner understand what this is in 30 seconds?" |
| End-to-end (where present) | A real browser clicking through real screens on a phone-sized viewport | "Does the app work, not just the rules?" |

A red gate is information, never an obstacle to route around. Fix the cause or, if the gate itself is wrong, fix the gate in its own PR with the reason written down.

**Lint is a ratchet.** Older code carries a backlog of lint errors. The number in `.lint-baseline` is that backlog; CI fails only if the count goes UP. New code never adds an error. When a session cleans some up, it lowers the number in the same PR so the improvement can't slip back. Zero is the destination.

---

## 2. Definition of Done

A change is done when every line below is true. Not most of them. All of them.

- Work happened on a branch and came in through a pull request. Nothing is pushed straight to `main`.
- Every CI check is green on the final commit.
- New behavior has a test. A fixed bug has a regression test: a test that fails on the old code and passes on the new code, so the bug cannot come back unnoticed. If no test is possible, the PR says so and why.
- Anything on the save path or the money path is called out in the PR under "Not tested" as a real-phone check for the owner to do after deploy, with the exact taps to make. The automatic gates are the blocker; the phone check is not, because the owner cannot be a required step in every merge.
- Any new check, guard, or test was shown failing on a planted bug before it was trusted. Green means nothing until you have seen it red.
- Database changes are migration files in the repo. Never a change made by hand in the Supabase dashboard. New tables have RLS (row-level security: each customer only sees their own rows, enforced by the database, not the app).
- Every database write checks its error response. Every scheduled job or edge function fails loudly.
- The PR body uses the four sections in section 3.
- Anything that surprised you is logged to the Brain as a lesson.

---

## 3. The PR summary

Copy these four headings exactly. The CI check looks for them and fails the PR if any is missing.

```
### What changed
### What could break
### How it was proven
### Not tested
```

Writing rules:

- Plain English. Anyone who has never seen code should understand it.
- One or two lines per bullet. Fifteen lines total is the ceiling.
- Every technical term gets a gloss the first time it appears: "RLS (row-level security, the database rule that keeps one ranch from seeing another's rows)".
- "How it was proven" names the command and the test. "Ran the tests" is not proof; "`npm test`, 171 passing, including the new `billing-refund.test.ts`" is.
- "Not tested" is never empty. If it is truly empty, say why that is credible. Anything that needs a real phone goes here with the exact taps to make.

---

## 4. Troubleshooting protocol

In this order. Skipping a step is how the same bug gets fixed three times.

1. **Reproduce.** Exact steps, which device, which account, which ranch. "It's broken" is not a report.
2. **Evidence before theory.** Browser console, network tab, Vercel runtime logs, Supabase logs. A fix proposed before the logs were read is a guess.
3. **List every cause, not the first cause.** Ask "what are all the reasons this could happen?" before "fix it." Stacked causes are the norm, not the exception.
4. **Fix the root cause.** Then write the regression test.
5. **Prove it.** Run the gates. Reproduce the original steps and confirm the fix on the preview deploy.
6. **Log the lesson** to the Brain: what broke, why, and the rule that prevents it next time.

---

## 5. Silent-failure rules

Nothing announces its own death unless it is built to. These are not optional.

- Every Supabase call checks `error` before touching `data`. A success toast on a failed write is a bug.
- Every `catch` block that swallows an error has a comment explaining why swallowing is correct here. `catch {}` with no comment is a defect.
- Every scheduled job, cron, and edge function writes a heartbeat (a row or log line that says "I ran at this time") and fails loudly when it cannot do its job.
- An integration that returns 200-OK and writes nothing is failing. Treat it that way.
- Production error monitoring stays on. The Sentry hook lives in the app entry point, is inert until the DSN environment variable is set in Vercel, and is never removed.
- Database check constraints and the exact strings the code writes are kept in sync. A constraint that silently rejects rows is a data-loss bug.

---

## 6. Architecture rules

- **One source of truth per fact.** If two places can answer the same question, one of them is wrong and you don't know which.
- **Server-side enforcement for anything that matters.** Premium gating, tenant isolation, billing. A check in the screen code is decoration; the database and edge functions are the lock.
- **Small files, one job each.** Aim for under 400 lines. Refactor a large file only after the tests that protect it exist. Never both in one PR.
- **Generated types stay fresh.** After a schema change, regenerate the Supabase types file. A widening cast (telling TypeScript to stop checking) is a documented hole: one per module, with a comment saying why and when it can go.
- **Decisions get written down.** A choice that shapes the system goes in `docs/decisions/` as a one-page record: what was chosen, why, what was rejected, what would make us revisit it.
- **Verify before you build.** Search the routes and screens for an existing version of the feature before writing a build-from-scratch prompt or the first line of code.

---

## 7. Session rules

- One Claude session per repo at a time.
- In a fresh container, install dependencies before anything else (`npm ci`).
- Stop conditions in handoff prompts are keyed to what must be TRUE ("does this table exist?"), never to a PR number.
- A session that ends its report with a question is parked until the owner answers. Do not end with a question when a reasonable default exists.

---

## 8. Writing for the owner

- Headings, short bullets, tables. Scannable in thirty seconds.
- Gloss every term the first time. "Concise but unclear" is a failure.
- Action items go at the end, under their own heading, verb first: RUN, DECIDE, APPROVE. Never buried mid-report.
- Never claim a gate passed without having seen it pass in this session.
