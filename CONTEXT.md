# reviewroom

A local workbench where a reviewer reads a diff with an agent's help: the agent tells the diff's story in a
walkthrough played over the live code, keeps the detail in a report, and the two talk it through in rounds.

## Language

### People

**Author**:
The person who wrote the diff under review.
_Avoid_: owner, submitter

**Reviewer**:
The person reviewing the diff in reviewroom. May be the author, when reviewing their own PR with an agent.
_Avoid_: user, you

**Agent**:
The coding agent that helps the reviewer: it writes the walkthrough and the report, and answers the reviewer's threads.
_Avoid_: author, bot

**Assistant**:
The agent built into reviewroom: a Claude Code conversation on the reviewer's machine, in the Assistant panel.
It can generate the walkthrough and report without an outside agent.
_Avoid_: bot, chat

### The review

**Diff**:
The code under review: everything between a base and a head, whether it comes from a PR or a local branch.
_Avoid_: change, changeset, PR (when no PR is involved)

**Review**:
One reviewer's review of one diff, with its walkthrough, report, threads and rounds.
_Avoid_: session, workspace

**Walkthrough**:
The story of the diff, played over the workbench: chapters of slides, narration beside the code each slide shows
(`walkthrough.json`). The reviewer sees it first; the report is where they dig in.
_Avoid_: guided walkthrough, tour, slideshow, presentation

**Slide**:
One step of a walkthrough: its narration and the code it shows (`steps` in `walkthrough.json`).
_Avoid_: page, card

**Report**:
The agent's detailed, freeform record of the review (`review.html`): findings, evidence, questions and later answers.
It need not mirror the walkthrough.
_Avoid_: walkthrough, narrative, review page, review.html

**Risks chapter**:
The final chapter of a walkthrough: the main risks as one-liners with severities, each linking to its finding in
the report. Detailed findings stay out of the slides.

**Finding**:
An actionable problem in the diff, with a severity, location, impact, evidence and suggested direction. It is a
section of the report with a stable id, so the Risks chapter can link to it.
_Avoid_: issue, comment

**Flagged question**:
A question the agent flags in the report for the reviewer to settle (`<rr-check>`); it may be partly or fully
settled over the review.
_Avoid_: open question, check, sign-off, checklist item

**Generation**:
The agent writing a review's walkthrough and report, followed by the reviewer on the loading screen until the
walkthrough passes its audit.

**GitHub review**:
The reviewer's pending or submitted review on the PR in GitHub. Separate from the review in reviewroom.

**Round**:
One cycle of the agent presenting the review and the reviewer responding. It ends when the reviewer sends feedback
or approves.
_Avoid_: iteration, pass

**Feedback**:
Everything the reviewer sends the agent when a round closes, together with the verdict: changes wanted, or approve.
_Avoid_: round summary

### Modes

**Peer review**:
Reviewing someone else's PR: the walkthrough first, then the report. The agent explains and reviews but never
changes the code, in any round. The mode reviewroom is built around; reviewing your own work is not described yet.
_Avoid_: team review

**Review profile**:
A composable skill reference saying what to look for and which sections or findings to add to the report.
`default` is the base profile; others add to it.
_Avoid_: template, checklist

### Conversation

**Thread**:
A conversation the reviewer starts about one anchor, or about the review as a whole.
_Avoid_: comment (for the whole conversation)

**Anchor**:
What a thread is about: a quote in the report, a line range in the diff, or a symbol.
_Avoid_: target, location

**Agent thread**:
A thread between the reviewer and the agent, answered round by round.

**Team thread**:
A thread on the PR in GitHub, visible to the whole team. The agent can read it but not reply.
_Avoid_: GitHub comment

### Serving

**Hub**:
The one page per machine that lists every running review (reviewroom, Crit, Plannotator), served by `reviewroom hub`.
_Avoid_: dashboard, index

**Hub proxy**:
The hub forwarding `/r/<review id>/...` to that review's own server, so every review is reachable from one origin.
_Avoid_: gateway, router

**Public origin**:
The one HTTPS URL the reviewer configures (`publicOrigin`) at which a front outside reviewroom makes the hub reachable
from a phone, for example `https://mac.tailnet.ts.net`. See `docs/adr/0001-phone-origin.md`.
_Avoid_: remote URL, tunnel URL

### Outside reviewroom

**CI checks**:
The results that CI reports for a commit on the PR.
_Avoid_: checks (bare)
