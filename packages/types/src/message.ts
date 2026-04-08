export type MessageType = 'text' | 'image' | 'file' | 'agent-task' | 'system';

export interface IMessage {
  _id: string | number;
  id?: string | number;
  podId: string;
  userId: string;
  username?: string;
  content: string;
  messageType?: MessageType;
  metadata?: Record<string, unknown>;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface IMessagePublic {
  _id: string | number;
  id?: string | number;
  content: string;
  username: string;
  profilePicture?: string;
  messageType?: MessageType;
  metadata?: Record<string, unknown>;
  createdAt?: string | Date;
}
