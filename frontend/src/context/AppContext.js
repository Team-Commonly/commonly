import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
import axios from 'axios';

// Create context
const AppContext = createContext();

// Create provider component
export const AppProvider = ({ children }) => {
    const [currentUser, setCurrentUser] = useState(null);
    const [posts, setPosts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshTrigger, setRefreshTrigger] = useState(0);

    // Function to trigger a refresh of data
    const refreshData = useCallback(() => {
        setRefreshTrigger(prev => prev + 1);
    }, []);

    // Fetch current user data
    useEffect(() => {
        const fetchCurrentUser = async () => {
            try {
                const token = localStorage.getItem('token');
                if (token) {
                    const response = await axios.get('/api/auth/me', {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    setCurrentUser(response.data);
                }
            } catch (error) {
                console.error('Error fetching current user:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchCurrentUser();
    }, [refreshTrigger]);

    // Fetch posts
    useEffect(() => {
        const fetchPosts = async () => {
            try {
                const response = await axios.get('/api/posts', {
                    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
                });
                setPosts(response.data);
            } catch (error) {
                console.error('Error fetching posts:', error);
            }
        };

        if (currentUser) {
            fetchPosts();
        }
    }, [currentUser, refreshTrigger]);

    // Context value
    const contextValue = {
        currentUser,
        setCurrentUser,
        posts,
        setPosts,
        loading,
        refreshData
    };

    return (
        <AppContext.Provider value={contextValue}>
            {children}
        </AppContext.Provider>
    );
};

// Custom hook to use the context
export const useAppContext = () => {
    return useContext(AppContext);
};

export default AppContext; 