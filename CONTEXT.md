# reviewroom

A local workbench where a reviewer reads a diff with an agent's help: the agent explains the diff in a
walkthrough beside the live diff, and the two talk it through in rounds.

## Language

### People

**Author**:
The person who wrote the diff under review.
_Avoid_: owner, submitter

**Reviewer**:
The person reviewing the diff in reviewroom. May be the author, when reviewing their own PR with an agent.
_Avoid_: user, you

**Agent**:
The coding agent that helps the reviewer: it writes the walkthrough and answers the reviewer's threads.
_Avoid_: author, assistant, bot

### The review

**Diff**:
The code under review: everything between a base and a head, whether it comes from a PR or a local branch.
_Avoid_: change, changeset, PR (when no PR is involved)

**Review**:
One reviewer's review of one diff, with its walkthrough, threads and rounds.
_Avoid_: session, workspace

**Walkthrough**:
The agent's freeform explanation of the diff, written for the reviewer to read alongside the diff.
_Avoid_: narrative, review, review page, review.html

**Guided walkthrough**:
The optional main story of the diff, played over the workbench: chapters of slides, narration beside the code each slide
shows. The reviewer sees it first; the walkthrough is where they dig in. Its file and commands keep the short name
(`walkthrough.json`, `reviewroom walkthrough …`), and its links are `rr:tour/<chapter>/<step>`.
_Avoid_: walkthrough (bare), tour, slideshow, presentation

**Slide**:
One step of a guided walkthrough: its narration and the code it shows (`steps` in `walkthrough.json`).
_Avoid_: page, card

**GitHub review**:
The reviewer's pending or submitted review on the PR in GitHub. Separate from the review in reviewroom.

**Round**:
One cycle of the agent presenting the walkthrough and the reviewer responding. It ends when the reviewer sends feedback
or approves.
_Avoid_: iteration, pass

**Feedback**:
Everything the reviewer sends the agent when a round closes, together with the verdict: changes wanted, or approve.
_Avoid_: round summary

**Open question**:
A question in the walkthrough that the agent and reviewer have no settled answer to yet; it may be partly or fully
answered over the review.
_Avoid_: check, sign-off, checklist item

### Conversation

**Thread**:
A conversation the reviewer starts about one anchor, or about the review as a whole.
_Avoid_: comment (for the whole conversation)

**Anchor**:
What a thread is about: a quote in the walkthrough, a line range in the diff, or a symbol.
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
