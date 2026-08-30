// Jira project bindings — the renderer's single doorway to the jiraProjects IPC
// surface (mirrors src/renderer/src/integrations/registryClient.ts). No mock
// fallback: unlike integrations (built before the preload bridge landed), this
// bridge ships with its IPC handlers from day one.

import type { JiraProjectBinding } from '@shared/jiraProjects';
export type { JiraProjectBinding, JiraPollSettings } from '@shared/jiraProjects';

interface JiraProjectsBridge {
  jiraProjectsList(): Promise<JiraProjectBinding[]>;
  jiraProjectsValidate(binding: JiraProjectBinding): Promise<{ ok: true } | { ok: false; error: string }>;
  jiraProjectsUpsert(binding: JiraProjectBinding): Promise<{ ok: true; bindings: JiraProjectBinding[] } | { ok: false; error: string }>;
  jiraProjectsRemove(key: string): Promise<{ ok: boolean }>;
}

function bridge(): JiraProjectsBridge {
  const b = (window as unknown as { cth: JiraProjectsBridge }).cth;
  return b;
}

export const jiraProjectsClient = {
  list: (): Promise<JiraProjectBinding[]> => bridge().jiraProjectsList(),
  validate: (binding: JiraProjectBinding) => bridge().jiraProjectsValidate(binding),
  save: (binding: JiraProjectBinding) => bridge().jiraProjectsUpsert(binding),
  remove: (key: string) => bridge().jiraProjectsRemove(key)
};
