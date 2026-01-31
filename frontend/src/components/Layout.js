/* eslint-disable max-len */
import React, { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Dashboard from './Dashboard';
import SearchBar from './SearchBar';
import WhatsHappening from './WhatsHappening';
import { Box, CircularProgress, Container, Paper, useTheme, useMediaQuery, IconButton } from '@mui/material';
import { useAuth } from '../context/AuthContext';
import { useLayout } from '../context/LayoutContext';
import './Layout.css';

const Layout = () => {
    const [searchResults, setSearchResults] = useState(null);
    const { loading } = useAuth();
    const { isDashboardCollapsed, toggleDashboard } = useLayout();
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
    const layoutClassName = `layout-container ${isPodDetail ? 'pod-detail' : ''} ${isDashboardCollapsed ? 'dashboard-collapsed' : ''} ${isMobile && !isDashboardCollapsed ? 'mobile-dashboard-open' : ''}`;
    if (isPodPage) {
        return (
            <div className={`pods-view ${layoutClassName}`}>
                <Dashboard />
                {isMobile && !isDashboardCollapsed && (
                    <div className="mobile-dashboard-backdrop" onClick={toggleDashboard} aria-hidden="true" />
                )}
                <div className="main-content pod-layout">
                    <div className="search-container">
                        <SearchBar onSearchResults={setSearchResults} />
                        <IconButton 
                            className="toggle-dashboard-button"
                            onClick={toggleDashboard}
                            aria-label={isDashboardCollapsed ? "Expand dashboard" : "Collapse dashboard"}
                            sx={{ ml: 1 }}
                        >
                            {isDashboardCollapsed ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="9 18 15 12 9 6"></polyline>
                                </svg>
                            ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="15 18 9 12 15 6"></polyline>
                                </svg>
                            )}
                        </IconButton>
                    </div>
                    <div className="content-container pod-content">
                        <Outlet context={searchResults} />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={layoutClassName}>
            <Dashboard />
            {isMobile && !isDashboardCollapsed && (
                <div className="mobile-dashboard-backdrop" onClick={toggleDashboard} aria-hidden="true" />
            )}
            <div className="main-content">
                <div className="search-container">
                    <SearchBar onSearchResults={setSearchResults} />
                    <IconButton 
                        className="toggle-dashboard-button"
                        onClick={toggleDashboard}
                        aria-label={isDashboardCollapsed ? "Expand dashboard" : "Collapse dashboard"}
                        sx={{ ml: 1 }}
                    >
                        {isDashboardCollapsed ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="9 18 15 12 9 6"></polyline>
                            </svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="15 18 9 12 15 6"></polyline>
                            </svg>
                        )}
                    </IconButton>
                </div>
                <Container maxWidth="xl" className="feed-container">
                    <div className="content-grid">
                        <div className="content-main">
                            <Outlet context={searchResults} />
                        </div>
                        {!isMobile && (
                            <div className="content-sidebar">
                                <WhatsHappening />
                            </div>
                        )}
                    </div>
                </Container>
            </div>
        </div>
    );
};

export default Layout;
