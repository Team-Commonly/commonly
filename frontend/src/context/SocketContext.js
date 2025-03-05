import React, { createContext, useContext, useEffect, useState } from 'react';
import io from 'socket.io-client';
import { useAuth } from './AuthContext';
import axios from 'axios';

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
                if (response.data.available && token && currentUser) {
                    try {
                        await axios.post('/api/pg/status/sync-user', {}, {
                            headers: {
                                'Authorization': `Bearer ${token}`
                            }
                        });
                        console.log('User synchronized with PostgreSQL for chat functionality');
                    } catch (err) {
                        console.error('Error syncing user to PostgreSQL:', err.message);
                    }
                }
            } catch (err) {
                console.error('PostgreSQL not available:', err.message);
                setPgAvailable(false);
            }
        };

        if (token) {
            checkPgAvailability();
        }
    }, [token, currentUser]);

    useEffect(() => {
        if (token && currentUser) {
            // Create socket connection with auth token
            const newSocket = io(process.env.REACT_APP_API_URL || '', {
                auth: {
                    token
                }
            });

            newSocket.on('connect', () => {
                console.log('Socket connected');
                setConnected(true);
            });

            newSocket.on('disconnect', () => {
                console.log('Socket disconnected');
                setConnected(false);
            });

            newSocket.on('error', (error) => {
                console.error('Socket error:', error);
            });

            setSocket(newSocket);

            return () => {
                newSocket.disconnect();
            };
        }
    }, [token, currentUser]);

    // Join a pod room
    const joinPod = (podId) => {
        if (socket && connected) {
            socket.emit('joinPod', podId);
        }
    };

    // Leave a pod room
    const leavePod = (podId) => {
        if (socket && connected) {
            socket.emit('leavePod', podId);
        }
    };

    // Send a message to a pod
    const sendMessage = (podId, content) => {
        if (socket && connected && currentUser) {
            socket.emit('sendMessage', {
                podId,
                content,
                userId: currentUser._id
            });
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