import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
import axios from 'axios';
import { useAuth } from './AuthContext';

interface Post {
  _id: string;
  [key: string]: unknown;
}

interface User {
  _id: string;
  username: string;
  email?: string;
  profilePicture?: string;
  [key: string]: unknown;
}

interface AppContextValue {
  currentUser: User | null;
  posts: Post[];
  setPosts: React.Dispatch<React.SetStateAction<Post[]>>;
  loading: boolean;
  userLoading: boolean;
  postsLoading: boolean;
  refreshData: () => void;
  updatePost: (postId: string, updatedData: Partial<Post>) => void;
  removePost: (postId: string) => void;
  refreshAvatars: () => void;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

interface AppProviderProps {
  children: React.ReactNode;
}

export const AppProvider: React.FC<AppProviderProps> = ({ children }) => {
  // AuthProvider already owns this request and wraps AppProvider in App.tsx.
  const { currentUser, loading: userLoading } = useAuth();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [postsLoading, setPostsLoading] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const refreshData = useCallback(() => {
    setRefreshTrigger((prev) => prev + 1);
  }, []);

  const refreshAvatars = useCallback(() => {
    refreshData();
    localStorage.setItem('avatar_updated', Date.now().toString());
    window.location.reload();
  }, [refreshData]);

  const updatePost = useCallback((postId: string, updatedData: Partial<Post>) => {
    setPosts((currentPosts) =>
      currentPosts.map((post) => (post._id === postId ? { ...post, ...updatedData } : post)),
    );
  }, []);

  const removePost = useCallback((postId: string) => {
    setPosts((currentPosts) => currentPosts.filter((post) => post._id !== postId));
  }, []);

  useEffect(() => {
    const fetchPosts = async () => {
      if (!currentUser) return;
      setPostsLoading(true);
      try {
        const response = await axios.get<Post[]>('/api/posts', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
        });
        setPosts(response.data);
      } catch (error) {
        console.error('Error fetching posts:', error);
      } finally {
        setPostsLoading(false);
      }
    };
    fetchPosts();
  }, [currentUser, refreshTrigger]);

  useEffect(() => {
    setLoading(userLoading || postsLoading);
  }, [userLoading, postsLoading]);

  return (
    <AppContext.Provider
      value={{
        currentUser,
        posts,
        setPosts,
        loading,
        userLoading,
        postsLoading,
        refreshData,
        updatePost,
        removePost,
        refreshAvatars,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = (): AppContextValue => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
};

export default AppContext;
