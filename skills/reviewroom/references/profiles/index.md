# Report profiles

A report profile gives the report its starting sections (`report.html` here) and a guide to what to
look for and what each section holds (`guide.md`). A review has one, picked when it is created:
`reviewroom pr <review> --profile <name>`, default `explainer`. `reviewroom status 'acme/api#31' --json` shows the
review's profile; read that profile's guide.

| Profile | Use |
| --- | --- |
| [explainer](explainer/guide.md) | Someone else's PR: explain it, then point out what needs attention. |

To add a profile, add a folder with both files and a line here.
