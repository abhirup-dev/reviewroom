import { createCodeService, type CodeService } from './review/code-service';
import { createGitHubService } from './threads/github-service';
import { createThreadService, type ThreadService } from './threads/service';

/** Explicit wiring for one review; neither service knows about the application shell. */
export function createReviewServices(deps: {
  github: Parameters<typeof createGitHubService>[0];
  code: Parameters<typeof createCodeService>[0];
  threads: Parameters<typeof createThreadService>[0];
}): { code: CodeService; threads: ThreadService; github: ReturnType<typeof createGitHubService> } {
  return {
    github: createGitHubService(deps.github),
    code: createCodeService(deps.code),
    threads: createThreadService(deps.threads),
  };
}

export type ReviewServices = ReturnType<typeof createReviewServices>;
