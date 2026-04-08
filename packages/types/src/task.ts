export type TaskStatus = 'pending' | 'claimed' | 'in-progress' | 'blocked' | 'done';

export interface ITaskUpdate {
  content: string;
  author: string;
  createdAt: string | Date;
}

export interface ITask {
  _id: string;
  podId: string;
  taskId: string;
  taskNum: number;
  title: string;
  description?: string;
  assignee?: string;
  status: TaskStatus;
  priority?: 'low' | 'medium' | 'high';
  sourceRef?: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  prUrl?: string;
  dep?: string;
  parentTask?: string;
  notes?: string;
  updates?: ITaskUpdate[];
  claimedAt?: string | Date;
  completedAt?: string | Date;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface ITaskCreateInput {
  title: string;
  description?: string;
  assignee?: string;
  priority?: ITask['priority'];
  sourceRef?: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  dep?: string;
  parentTask?: string;
  createGithubIssue?: boolean;
}
