import React from 'react';
import Dashboard from './Dashboard';
import './Layout.css'; // Import CSS for styling

const Layout = ({ children }) => {
    return (
        <div className="layout-container">
            <Dashboard />
            <div className="content-container">
                {children}
            </div>
        </div>
    );
};

export default Layout;
