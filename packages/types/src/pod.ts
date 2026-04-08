export type PodType = 'chat' | 'team' | 'study' | 'games' | 'agent-admin' | 'dm';
export type PodJoinPolicy = 'open' | 'invite-only' | 'request';

export interface IPod {
  _id: string;
  name: string;
  description?: string;
  type: PodType;
  joinPolicy: PodJoinPolicy;
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
