export type PodType = 'chat' | 'team' | 'study' | 'games' | 'project' | 'agent-admin' | 'dm';
export type PodJoinPolicy = 'open' | 'invite-only' | 'request';

export interface IPod {
  _id: string;
  name: string;
  description?: string;
  type: PodType;
  joinPolicy: PodJoinPolicy;
  projectMeta?: {
    goal?: string;
    scope?: string;
    successCriteria?: string[];
    status?: 'planning' | 'on-track' | 'at-risk' | 'blocked' | 'complete';
    dueDate?: string | Date | null;
    ownerIds?: string[];
    keyLinks?: Array<{ label: string; url: string }>;
  };
  members: string[];
  createdBy: string;
  isPrivate?: boolean;
  category?: string;
  tags?: string[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface IPodPublic {
  _id: string;
  name: string;
  description?: string;
  type: PodType;
  joinPolicy: PodJoinPolicy;
  memberCount: number;
  category?: string;
}
