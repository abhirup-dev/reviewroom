// "Use my own agent": the prompt the reviewer pastes into an agent they run themselves.

/** One POSIX shell word: bare when it has nothing the shell would read, else single-quoted. */
export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** The agent sets up the review, writes its artifacts, and waits for feedback. */
export const ownAgentPrompt = (target: string, repo: string) =>
  `Review ${target} with reviewroom: run \`reviewroom pr ${shellQuote(target)} --repo ${shellQuote(repo)}\`, follow the reviewroom skill to write the walkthrough and report, then run \`reviewroom wait ${shellQuote(target)} --repo ${shellQuote(repo)}\`.`;
