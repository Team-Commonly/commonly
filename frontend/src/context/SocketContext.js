import React, { createContext, useContext, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import io from 'socket.io-client';
import { useAuth } from './AuthContext';
import axios from 'axios';
import getApiBaseUrl from '../utils/apiBaseUrl';

const SocketContext = createContext();

export const useSocket = () => useContext(SocketContext);
// Add alias for backward compatibility
export const useSocketContext = () => useContext(SocketContext);

export const SocketProvider = ({ children }) => {
    const [socket, setSocket] = useState(null);
    const [connected, setConnected] = useState(false);
    const [pgAvailable, setPgAvailable] = useState(false);
    const { token, currentUser } = useAuth();

    // Check if PostgreSQL is available for chat functionality
    useEffect(() => {
        const checkPgAvailability = async () => {
            try {
                const response = await axios.get('/api/pg/status');
                setPgAvailable(response.data.available);
                
                // If PostgreSQL is available and user is logged in, sync user data
                if (response.data.available && token && currentUser && currentUser._id) {
                    try {
                        await axios.post('/api/pg/status/sync-user', {}, {
                            headers: {
                                'Authorization': `Bearer ${token}`
                            }
                        });
                        console.log('User synchronized with PostgreSQL for chat functionality');
                    } catch (err) {
                        console.error('Error syncing user to PostgreSQL:', err.message);
                        // Don't set pgAvailable to false here, as it might be a temporary error
                    }
                } else if (response.data.available && (!currentUser || !currentUser._id)) {
                    console.warn('User data is not fully loaded yet, skipping PostgreSQL sync');
                }
            } catch (err) {
                console.error('PostgreSQL not available:', err.message);
                setPgAvailable(false);
            }
        };

        if (token && currentUser) {
            checkPgAvailability();
        }
    }, [token, currentUser]);

    useEffect(() => {
        if (token && currentUser && currentUser._id) {
            // Create socket connection with auth token
            console.log('Attempting to connect to socket server...');
            
            // Check if we have a valid API URL
            const apiUrl = getApiBaseUrl();
            console.log('Using API URL for socket connection:', apiUrl);
            
            const newSocket = io(apiUrl, {
                auth: {
                    token
                },
                transports: ['websocket', 'polling'], // Try WebSocket first, then fall back to polling
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 1000
            });

            newSocket.on('connect', () => {
                console.log('Socket connected successfully');
                setConnected(true);
            });

            newSocket.on('welcome', (data) => {
                console.log('Received welcome message from server:', data.message);
                // Connection is now fully established and authenticated
            });

            newSocket.on('connect_error', (error) => {
                console.error('Socket connection error:', error.message);
                setConnected(false);
            });

            newSocket.on('disconnect', (reason) => {
                console.log('Socket disconnected, reason:', reason);
                setConnected(false);
            });

            newSocket.on('error', (error) => {
                console.error('Socket error:', error);
                setConnected(false);
            });

            setSocket(newSocket);

            return () => {
                console.log('Cleaning up socket connection');
                newSocket.disconnect();
            };
        } else {
            console.warn('Not connecting socket: missing token or user data');
        }
    }, [token, currentUser]);

    // Join a pod room
    const joinPod = (podId) => {
        if (socket && connected && podId) {
            socket.emit('joinPod', podId);
        }
    };

    // Leave a pod room
    const leavePod = (podId) => {
        if (socket && connected && podId) {
            socket.emit('leavePod', podId);
        }
    };

    // Send a message to a pod
    const sendMessage = (podId, content, messageType = 'text', replyToMessageId = null) => {
        if (socket && connected && currentUser && currentUser._id && podId) {
            socket.emit('sendMessage', {
                podId,
                content,
                messageType,
                userId: currentUser._id,
                ...(replyToMessageId && { replyToMessageId }),
            });
        } else {
            console.warn('Cannot send message: socket, user, or podId is missing');
        }
    };

    return (
        <SocketContext.Provider
            value={{
                socket,
                connected,
                pgAvailable,
                joinPod,
                leavePod,
                sendMessage
            }}
        >
            {children}
        </SocketContext.Provider>
    );
};

SocketProvider.propTypes = {
    children: PropTypes.node.isRequired
}; 
