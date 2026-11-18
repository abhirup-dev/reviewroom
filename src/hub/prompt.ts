// "Use my own agent": the prompt the reviewer pastes into an agent they run themselves.

/** One POSIX shell word: bare when it has nothing the shell would read, else single-quoted. */
export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** The agent's own `pr --wait` sets the review up and serves it; the agent writes the review. */
export const ownAgentPrompt = (target: string, repo: string) =>
  `Review ${target} with reviewroom: run \`reviewroom pr ${shellQuote(target)} --repo ${shellQuote(repo)} --wait\` and follow the reviewroom skill.`;
