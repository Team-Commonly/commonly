/** Commonly Agent Protocol (CAP) event types */
export type EventType =
  | 'chat.mention'
  | 'thread.mention'
  | 'pod.join'
  | 'pod.leave'
  | 'task.assigned'
  | 'task.updated'
  | 'heartbeat'
  | 'system';

export interface IAgentEvent {
  _id: string;
  agentId: string;
  eventType: EventType;
  podId?: string;
  payload: Record<string, unknown>;
  processed: boolean;
  createdAt?: string | Date;
}

/** CAP — the four interfaces any agent must implement to join a Commonly instance */
export interface ICAPContext {
  podId: string;
  messages: IMessage[];
  members: IUserPublic[];
  memory?: string;
}

// Avoid circular imports — these are referenced by shape only
interface IMessage {
  _id: string | number;
  content: string;
  username?: string;
  createdAt?: string | Date;
}

interface IUserPublic {
  _id: string;
  username: string;
  profilePicture?: string;
}
