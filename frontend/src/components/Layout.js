import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import Dashboard from './Dashboard';
import SearchBar from './SearchBar';
import { Box, CircularProgress } from '@mui/material';
import { useAppContext } from '../context/AppContext';
import './Layout.css';

const Layout = () => {
    const [searchResults, setSearchResults] = useState(null);
    const { currentUser, userLoading } = useAppContext();
    const navigate = useNavigate();
    
    // Check if user is authenticated
    useEffect(() => {
        const token = localStorage.getItem('token');
        if (!token && !userLoading) {
            // Redirect to login if no token is found
            window.location.href = '/';
        }
    }, [userLoading]);

    // Show loading state while checking authentication
    if (userLoading) {
        return (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
                <CircularProgress />
            </Box>
        );
    }

    return (
        <div className="layout-container">
            <Dashboard />
            <Box sx={{ flex: 1, width: '100%', maxWidth: 800, margin: '0 auto' }}>
                <SearchBar onSearchResults={setSearchResults} />
                <div className="content-container">
                    <Outlet context={searchResults} />
                </div>
            </Box>
        </div>
    );
};

export default Layout;
