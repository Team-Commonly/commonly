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
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  watchers?: string[];
  claimedBy?: string | null;
  claimExpiresAt?: string | Date | null;
  sourceRef?: string;
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
  dep?: string;
  parentTask?: string;
}
