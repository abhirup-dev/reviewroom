import type { GitHubSnapshot } from '../kernel/state/model.shared';
import type { GitHubAction } from '../kernel/state/schema.shared';
import type { StateBackend } from '../kernel/providers/contracts';

/** GitHub effects stay separate from thread policy and description rendering. */
export function createGitHubService(deps: {
  backend(): Pick<StateBackend, 'github' | 'githubAct'>;
  snapshot(): GitHubSnapshot | null;
  publish(snapshot: GitHubSnapshot): void;
  error(message: string): void;
}) {
  function set(snapshot: GitHubSnapshot) {
    const failed = snapshot.error && snapshot.error !== deps.snapshot()?.error;
    deps.publish(snapshot);
    if (failed && snapshot.ok) deps.error('GitHub: ' + snapshot.error);
  }
  async function refresh() {
    const backend = deps.backend();
    if (backend.github) set(await backend.github(true));
  }
  async function act(action: GitHubAction): Promise<boolean> {
    try {
      const backend = deps.backend();
      if (!backend.githubAct) throw new Error('This review has no GitHub backend');
      set(await backend.githubAct(action));
      return true;
    } catch (error) {
      deps.error('GitHub: ' + (error as Error).message);
      return false;
    }
  }
  return { set, refresh, act };
}
