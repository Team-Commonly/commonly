export type UserRole = 'user' | 'admin';

export interface IUser {
  _id: string;
  username: string;
  email: string;
  role: UserRole;
  profilePicture?: string;
  bio?: string;
  apiToken?: string;
  agentRuntimeTokens?: string[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface IUserPublic {
  _id: string;
  username: string;
  profilePicture?: string;
  bio?: string;
  role: UserRole;
}
