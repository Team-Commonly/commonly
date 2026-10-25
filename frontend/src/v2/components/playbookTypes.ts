export interface PlaybookDefinition {
  v: 1;
  roles: { key: string; kind: 'agent' | 'person' }[];
  steps: {
    key: string;
    title: string;
    role: string;
    do: string;
    reads?: string[];
    delivers?: 'post' | 'pr';
    writeGap?: string;
    approval?: { by: string; act: 'actor' | 'kernel'; effect?: 'none' };
  }[];
  done: { says: string; check: 'approved' | 'done' | 'by-person' | 'has-pr'; step: string }[];
}
export interface Playbook {
  id: string;
  title: string;
  definition: PlaybookDefinition;
  sourceText: string;
  bindings: Record<string, string>;
  on: boolean;
  onBy: string | null;
  error: string | null;
  schedule: { cron: string; timezone: string } | null;
}
export interface PlaybookOptions {
  enabled: boolean;
  members: {
    userId: string;
    handle: string;
    label?: string;
    kind: 'agent' | 'person';
    runtime?: string;
  }[];
  tools: { name: string; mode: string; audience: string[] }[];
}
export interface PlaybookRun {
  definition?: PlaybookDefinition;
  bindings?: Record<string, string>;
  members?: PlaybookOptions['members'];
  taskId: string;
  status: string;
  lastUpdate: string;
  createdAt: string;
  steps: {
    taskId: string;
    key: string;
    title: string;
    status: string;
    assignee: string;
    guard?: string;
    completedBy: string | null;
    prUrl: string | null;
    ruling: { state: string; approvalId: string } | null;
  }[];
}
