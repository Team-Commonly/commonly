import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Dashboard from './Dashboard';
import SearchBar from './SearchBar';
import { Box } from '@mui/material';
import './Layout.css';

const Layout = () => {
    const [searchResults, setSearchResults] = useState(null);

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
