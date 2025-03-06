import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import Dashboard from './Dashboard';
import SearchBar from './SearchBar';
import { Box, CircularProgress, Container, Paper, useTheme, useMediaQuery } from '@mui/material';
import { useAuth } from '../context/AuthContext';
import './Layout.css';

const Layout = () => {
    const [searchResults, setSearchResults] = useState(null);
    const { currentUser, loading } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('md'));
    
    // Check if user is authenticated
    useEffect(() => {
        const token = localStorage.getItem('token');
        if (!token && !loading) {
            // Redirect to login if no token is found
            window.location.href = '/';
        }
    }, [loading]);

    // Show loading state while checking authentication
    if (loading) {
        return (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
                <CircularProgress />
            </Box>
        );
    }

    // Determine if we're on a pod page
    const isPodPage = location.pathname.includes('/pods');
    const isPodDetail = isPodPage && location.pathname.split('/').length > 3;
    
    // Use different layout for pod pages
    if (isPodPage) {
        return (
            <div className={`layout-container pods-view ${isPodDetail ? 'pod-detail' : ''}`}>
                <Dashboard />
                <div className="main-content pod-layout">
                    <div className="search-container">
                        <SearchBar onSearchResults={setSearchResults} />
                    </div>
                    <div className="content-container pod-content">
                        <Outlet context={searchResults} />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="layout-container">
            <Dashboard />
            <div className="main-content">
                <div className="search-container">
                    <SearchBar onSearchResults={setSearchResults} />
                </div>
                <Container maxWidth="xl" className="feed-container">
                    <div className="content-grid">
                        <div className="content-main">
                            <Outlet context={searchResults} />
                        </div>
                        {!isMobile && (
                            <div className="content-sidebar">
                                <Paper elevation={0} className="trending-section">
                                    <h3>What's happening</h3>
                                    <div className="trending-topics">
                                        <div className="trending-topic">
                                            <span className="topic-category">Trending in Technology</span>
                                            <h4>#AIRevolution</h4>
                                            <span className="topic-posts">2,543 posts</span>
                                        </div>
                                        <div className="trending-topic">
                                            <span className="topic-category">Entertainment</span>
                                            <h4>New streaming releases</h4>
                                            <span className="topic-posts">1,287 posts</span>
                                        </div>
                                        <div className="trending-topic">
                                            <span className="topic-category">Science</span>
                                            <h4>#SpaceExploration</h4>
                                            <span className="topic-posts">4,892 posts</span>
                                        </div>
                                    </div>
                                </Paper>
                            </div>
                        )}
                    </div>
                </Container>
            </div>
        </div>
    );
};

export default Layout;
