import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
import PropTypes from 'prop-types';
import axios from 'axios';

// Create context
const AppContext = createContext();

// Create provider component
export const AppProvider = ({ children }) => {
    const [currentUser, setCurrentUser] = useState(null);
    const [posts, setPosts] = useState([]);
    const [loading, setLoading] = useState(false);
    const [userLoading, setUserLoading] = useState(true);
    const [postsLoading, setPostsLoading] = useState(true);
    const [refreshTrigger, setRefreshTrigger] = useState(0);

    // Function to trigger a refresh of data
    const refreshData = useCallback(() => {
        setRefreshTrigger(prev => prev + 1);
    }, []);
    
    // Function to specifically refresh avatar colors across all components
    const refreshAvatars = useCallback(() => {
        // Also trigger a full data refresh to ensure consistency
        refreshData();
        
        // Force socket reconnection by storing a flag in localStorage
        localStorage.setItem('avatar_updated', Date.now().toString());
        
        // We need to force a full page reload to refresh components that don't
        // automatically pick up context changes (like Dashboard and ChatRoom)
        window.location.reload();
    }, [refreshData]);

    // Function to directly update a post in the posts array
    const updatePost = useCallback((postId, updatedData) => {
        setPosts(currentPosts => 
            currentPosts.map(post => 
                post._id === postId ? { ...post, ...updatedData } : post
            )
        );
    }, []);

    // Function to remove a post from the posts array
    const removePost = useCallback((postId) => {
        setPosts(currentPosts => currentPosts.filter(post => post._id !== postId));
    }, []);

    // Fetch current user data
    useEffect(() => {
        const fetchCurrentUser = async () => {
            setUserLoading(true);
            try {
                const token = localStorage.getItem('token');
                if (!token) {
                    setUserLoading(false);
                    return;
                }
                
                const response = await axios.get('/api/auth/user', {
                    headers: { Authorization: `Bearer ${token}` }
                });
                setCurrentUser(response.data);
            } catch (error) {
                console.error('Error fetching current user:', error);
            } finally {
                setUserLoading(false);
            }
        };

        fetchCurrentUser();
    }, [refreshTrigger]);

    // Fetch posts
    useEffect(() => {
        const fetchPosts = async () => {
            if (!currentUser) return;
            
            setPostsLoading(true);
            try {
                const response = await axios.get('/api/posts', {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
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

    // Combine loading states
    useEffect(() => {
        setLoading(userLoading || postsLoading);
    }, [userLoading, postsLoading]);

    // Context value
    const contextValue = {
        currentUser,
        setCurrentUser,
        posts,
        setPosts,
        loading,
        userLoading,
        postsLoading,
        refreshData,
        updatePost,
        removePost,
        refreshAvatars
    };

    return (
        <AppContext.Provider value={contextValue}>
            {children}
        </AppContext.Provider>
    );
};

AppProvider.propTypes = {
    children: PropTypes.node.isRequired
};

// Custom hook to use the context
export const useAppContext = () => {
    return useContext(AppContext);
};

export default AppContext; 