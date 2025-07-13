import React, { useContext, useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { Box, CircularProgress, Alert } from '@mui/material';
import axios from 'axios';

const ProtectedRoute = ({ children, requireAdmin = false }) => {
    const { user, isAuthenticated } = useContext(AuthContext);
    const [loading, setLoading] = useState(requireAdmin);
    const [hasAccess, setHasAccess] = useState(false);

    useEffect(() => {
        if (requireAdmin && isAuthenticated) {
            const checkAdminAccess = async () => {
                try {
                    const token = localStorage.getItem('token');
                    await axios.get('/api/auth/admin/check', {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    setHasAccess(true);
                } catch (error) {
                    console.error('Admin access check failed:', error);
                    setHasAccess(false);
                } finally {
                    setLoading(false);
                }
            };

            checkAdminAccess();
        } else if (!requireAdmin) {
            setHasAccess(true);
            setLoading(false);
        }
    }, [requireAdmin, isAuthenticated]);

    if (!isAuthenticated) {
        return <Navigate to="/" replace />;
    }

    if (loading) {
        return (
            <Box display="flex" justifyContent="center" alignItems="center" minHeight="50vh">
                <CircularProgress />
            </Box>
        );
    }

    if (requireAdmin && !hasAccess) {
        return (
            <Box p={3}>
                <Alert severity="error">
                    Admin access required. You do not have permission to view this page.
                </Alert>
            </Box>
        );
    }

    return children;
};

export default ProtectedRoute;