# Report profiles

A report profile is a folder here holding `report.html` (the report's starting sections) and
`guide.md` (what to look for and what each section holds). A review uses one, for now:
`reviewroom pr --profile <name>` picks it when the review is created (default `default`) and builds
the report from its sections. Read the guide of the review's profile, named by `profile` in the
review's `config.json` (`reviewroom status --json`, under `config`).

| Profile | Use |
| --- | --- |
| [default](default/guide.md) | Understand the diff, review its risks and evidence; the report for someone else's PR. |

To add a profile, create `references/profiles/<name>/` with both files and add one line to this
index. The guide states when to use it, what to look for and what each section holds. A profile
does not change the writing order or allow code changes on someone else's PR.
