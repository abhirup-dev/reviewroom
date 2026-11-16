# Review profiles

Read [default](default.md) for every review. Add profiles when the reviewer asks or the diff calls
for them. Compose them: keep the default and apply each addition's guidance to the relevant sections.
Combine overlapping findings rather than repeat them.

| Profile | Use |
| --- | --- |
| [default](default.md) | Understand the diff, review its risks and evidence; shape the walkthrough for someone else's PR. |

To add a profile, create `references/profiles/<name>.md` and add one line to this index. State when
to use it, what to look for, and which sections or findings it adds. Profiles guide the review;
they add no element, CLI flag or validation rule. They do not change the writing order or allow
code changes on someone else's PR.
