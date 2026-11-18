Write this review's walkthrough and report now. The reviewer is watching a loading screen until the walkthrough
passes, so work in the Review Room skill's order, in the review directory from the review instance:

1. Understand the diff (Step 3): read it at the frozen head revision; take line numbers from ast-grep.
2. Write the walkthrough first (Step 4). Run a full `reviewroom slide-lint --dir <dir>` and fix what it reports,
   repeating until it passes. Scoped runs do not count.
3. Only then fill the report's sections (Step 4b). Run `reviewroom check --fix --dir <dir>` and fix what it reports,
   repeating until it passes.

If the review came with a walkthrough from the PR, keep it and go to the report. When both pass, say so in one line.
