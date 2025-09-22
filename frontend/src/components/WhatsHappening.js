import React, { useState, useEffect } from 'react';
import { Paper, Box, Typography, CircularProgress, Chip, Divider, IconButton, Tooltip, Card, CardContent, Collapse } from '@mui/material';
import { formatDistanceToNow } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import RefreshIcon from '@mui/icons-material/Refresh';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import ChatIcon from '@mui/icons-material/Chat';
import PostAddIcon from '@mui/icons-material/PostAdd';
import SchoolIcon from '@mui/icons-material/School';
import SportsEsportsIcon from '@mui/icons-material/SportsEsports';
import LaunchIcon from '@mui/icons-material/Launch';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import WhatshotIcon from '@mui/icons-material/Whatshot';

const WhatsHappening = () => {
  const navigate = useNavigate();
  const [summaries, setSummaries] = useState({ 
    posts: null, 
    chats: null, 
    chatRooms: [], 
    studyRooms: [],
    gameRooms: [],
    allPosts: null 
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    chatRooms: true,
    studyRooms: false,
    gameRooms: false
  });

  const fetchSummaries = async (showRefreshing = false) => {
    try {
      if (showRefreshing) setRefreshing(true);
      else setLoading(true);

      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('No authentication token found');
      }

      const headers = { Authorization: `Bearer ${token}` };

      // Fetch all pod types and summaries
      const [
        latestResponse, 
        chatRoomsResponse, 
        studyRoomsResponse,
        gameRoomsResponse,
        allPostsResponse
      ] = await Promise.all([
        axios.get('/api/summaries/latest', { headers }),
        axios.get('/api/summaries/chat-rooms?limit=3', { headers }),
        axios.get('/api/summaries/study-rooms?limit=3', { headers }).catch(() => ({ data: [] })),
        axios.get('/api/summaries/game-rooms?limit=3', { headers }).catch(() => ({ data: [] })),
        axios.get('/api/summaries/all-posts', { headers })
      ]);

      setSummaries({
        ...latestResponse.data,
        chatRooms: chatRoomsResponse.data,
        studyRooms: studyRoomsResponse.data,
        gameRooms: gameRoomsResponse.data,
        allPosts: allPostsResponse.data
      });
      setError(null);
    } catch (err) {
      console.error('Error fetching summaries:', err);
      setError(err.response?.data?.error || 'Failed to fetch summaries');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchSummaries();
    
    // Refresh summaries every 5 minutes
    const interval = setInterval(() => {
      fetchSummaries();
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    try {
      setRefreshing(true);
      
      const token = localStorage.getItem('token');
      if (!token) {
        throw new Error('No authentication token found');
      }

      // First trigger fresh summary generation
      console.log('Triggering fresh summary generation...');
      await axios.post('/api/summaries/trigger', {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      // Wait a moment for summaries to be generated
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Then fetch the updated summaries
      await fetchSummaries(false);
      
    } catch (error) {
      console.error('Error during refresh:', error);
      // Fall back to just fetching existing summaries
      await fetchSummaries(false);
    } finally {
      setRefreshing(false);
    }
  };

  const handleTagClick = (tag) => {
    navigate(`/feed?q=${encodeURIComponent(tag)}`);
  };

  const handlePodClick = (podId, podType) => {
    if (!podId) {
      console.warn('No podId provided for navigation');
      return;
    }
    
    console.log('Navigating to pod:', { podId, podType });
    
    // Navigate to the specific pod
    if (podType === 'chat') {
      navigate(`/pods/chat/${podId}`);
    } else if (podType === 'study') {
      navigate(`/pods/study/${podId}`);
    } else if (podType === 'game' || podType === 'games') {
      navigate(`/pods/games/${podId}`);
    } else {
      // Fallback - try to determine type or use generic route
      navigate(`/pods/${podId}`);
    }
  };

  const handleViewAllPods = (podType) => {
    navigate(`/pods/${podType}`);
  };

  const toggleSection = (sectionKey) => {
    setExpandedSections(prev => ({
      ...prev,
      [sectionKey]: !prev[sectionKey]
    }));
  };

  const SummaryCard = ({ summary, type, icon }) => {
    if (!summary) {
      return (
        <Box sx={{ p: 2, opacity: 0.6 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
            {icon}
            <Typography variant="subtitle2" sx={{ ml: 1, color: 'text.secondary' }}>
              {type === 'posts' ? 'Quiet Hour' : 'No Recent Activity'}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {type === 'posts' 
              ? 'No new posts were shared in the last hour. The community is taking a peaceful break.' 
              : 'No chat activity in the last hour.'
            }
          </Typography>
        </Box>
      );
    }

    return (
      <Box sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: 1 }}>
            {icon}
            <Typography 
              variant="subtitle2" 
              sx={{ 
                ml: 1, 
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1
              }}
            >
              {summary.title}
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1, flexShrink: 0 }}>
            {formatDistanceToNow(new Date(summary.createdAt), { addSuffix: true })}
          </Typography>
        </Box>
        
        <Typography 
          variant="body2" 
          color="text.secondary" 
          sx={{ 
            mb: 1.5, 
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}
        >
          {summary.content}
        </Typography>

        {summary.metadata && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: type === 'chats' ? 1 : 0 }}>
            {summary.metadata.totalItems > 0 && (
              <Chip 
                size="small" 
                label={`${summary.metadata.totalItems} ${type === 'posts' ? 'posts' : 'messages'}`}
                variant="outlined"
                sx={{ fontSize: '0.7rem', height: 20 }}
              />
            )}
            {summary.metadata.topTags?.slice(0, 2).map((tag, index) => (
              <Chip 
                key={index}
                size="small" 
                label={type === 'posts' ? `#${tag}` : tag}
                color="primary"
                variant="outlined"
                sx={{ 
                  fontSize: '0.7rem', 
                  height: 20,
                  cursor: 'pointer',
                  '&:hover': {
                    backgroundColor: 'primary.light',
                    transform: 'scale(1.02)'
                  }
                }}
                onClick={() => handleTagClick(tag)}
              />
            ))}
          </Box>
        )}

        {/* Show most active chat rooms from all chat pod types (chat, study, games) */}
        {type === 'chats' && (
          <Box sx={{ mt: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
              <WhatshotIcon sx={{ fontSize: 14, color: 'warning.main', mr: 0.5 }} />
              <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                Most Active Rooms
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {(() => {
                // Combine all chat pod types (chat, study, games) and sort by activity
                const allChatRooms = [
                  ...(summaries.chatRooms || []).map(room => ({ ...room, chatType: 'chat' })),
                  ...(summaries.studyRooms || []).map(room => ({ ...room, chatType: 'study' })),
                  ...(summaries.gameRooms || []).map(room => ({ ...room, chatType: 'games' }))
                ]
                .filter(room => room.metadata?.totalItems > 0) // Only rooms with activity
                .sort((a, b) => (b.metadata?.totalItems || 0) - (a.metadata?.totalItems || 0)) // Sort by message count
                .slice(0, 3); // Show top 3 most active

                return allChatRooms.map((room, index) => {
                  const podId = room.podId || room._id;
                  const podName = room.metadata?.podName || `${room.chatType} Room`;
                  const messageCount = room.metadata?.totalItems || 0;
                  
                  // Different colors for different chat pod types
                  const chatTypeColors = {
                    chat: 'secondary',    // General chat rooms
                    study: 'success',     // Study-focused chat rooms  
                    games: 'warning'      // Game-focused chat rooms
                  };
                  
                  return (
                    <Chip
                      key={room._id || index}
                      size="small"
                      label={`${podName} (${messageCount})`}
                      variant="filled"
                      color={chatTypeColors[room.chatType] || 'secondary'}
                      sx={{
                        fontSize: '0.65rem',
                        height: 18,
                        cursor: 'pointer',
                        '&:hover': {
                          transform: 'scale(1.05)',
                          backgroundColor: `${chatTypeColors[room.chatType] || 'secondary'}.dark`
                        },
                        transition: 'all 0.2s ease'
                      }}
                      onClick={() => handlePodClick(podId, room.chatType)}
                    />
                  );
                });
              })()}
            </Box>
          </Box>
        )}
      </Box>
    );
  };

  const PodSection = ({ rooms, title, icon, podType, color, sectionKey }) => {
    if (!rooms || rooms.length === 0) return null;

    const isExpanded = expandedSections[sectionKey];
    const sortedRooms = rooms
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5); // Show only top 5 most recent

    return (
      <>
        <Divider sx={{ mx: 2, my: 1 }} />
        <Box sx={{ px: 2, pb: isExpanded ? 1 : 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Box 
              sx={{ 
                display: 'flex', 
                alignItems: 'center',
                cursor: 'pointer',
                '&:hover': { opacity: 0.8 }
              }}
              onClick={() => toggleSection(sectionKey)}
            >
              <Typography 
                variant="subtitle2" 
                sx={{ 
                  fontWeight: 600, 
                  color: `${color}.main`,
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                {icon}
                {title}
                <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
                  ({sortedRooms.length})
                </Typography>
                {isExpanded ? 
                  <ExpandLessIcon sx={{ ml: 0.5, fontSize: 16 }} /> : 
                  <ExpandMoreIcon sx={{ ml: 0.5, fontSize: 16 }} />
                }
              </Typography>
            </Box>
            <Chip 
              size="small"
              label={`View All`}
              variant="outlined"
              color={color}
              sx={{ 
                fontSize: '0.65rem', 
                height: 18,
                cursor: 'pointer',
                '&:hover': {
                  backgroundColor: `${color}.light`
                }
              }}
              onClick={() => handleViewAllPods(podType)}
              icon={<LaunchIcon sx={{ fontSize: 12 }} />}
            />
          </Box>
          
          <Collapse in={isExpanded}>
            <Box>
              {sortedRooms.map((roomSummary, index) => {
                // The podId should be available directly on the summary object
                const podId = roomSummary.podId || roomSummary._id;
                const podName = roomSummary.metadata?.podName || `${title} Room`;
                
                console.log('Room summary data:', { 
                  roomSummary, 
                  podId, 
                  podName, 
                  podType,
                  summaryId: roomSummary._id 
                });

                return (
                  <Card 
                    key={roomSummary._id || index} 
                    variant="outlined"
                    sx={{ 
                      mb: 1, 
                      cursor: 'pointer',
                      borderLeft: `3px solid`,
                      borderLeftColor: `${color}.main`,
                      '&:hover': {
                        boxShadow: 2,
                        transform: 'translateY(-1px)',
                        borderLeftColor: `${color}.dark`
                      },
                      transition: 'all 0.2s ease'
                    }}
                    onClick={() => handlePodClick(podId, podType)}
                  >
                    <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
                        <Typography 
                          variant="subtitle2" 
                          sx={{ 
                            fontWeight: 600,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            flex: 1
                          }}
                        >
                          {podName}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 1, flexShrink: 0 }}>
                          {formatDistanceToNow(new Date(roomSummary.createdAt), { addSuffix: true })}
                        </Typography>
                      </Box>
                      
                      <Typography 
                        variant="body2" 
                        color="text.secondary" 
                        sx={{ 
                          mb: 0.5,
                          lineHeight: 1.3,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden'
                        }}
                      >
                        {roomSummary.content}
                      </Typography>
                      
                      {roomSummary.metadata?.totalItems > 0 && (
                        <Chip 
                          size="small" 
                          label={`${roomSummary.metadata.totalItems} messages`}
                          variant="outlined"
                          color={color}
                          sx={{ fontSize: '0.65rem', height: 18 }}
                        />
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </Box>
          </Collapse>
        </Box>
      </>
    );
  };

  if (loading) {
    return (
      <Paper elevation={0} className="trending-section">
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
          <CircularProgress size={24} />
          <Typography variant="body2" sx={{ ml: 1 }}>
            Loading what&apos;s happening...
          </Typography>
        </Box>
      </Paper>
    );
  }

  return (
    <Paper elevation={0} className="trending-section">
      <Box sx={{ p: 2, pb: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <TrendingUpIcon sx={{ mr: 1, color: 'primary.main' }} />
            <Typography variant="h6" component="h3" sx={{ fontWeight: 600 }}>
              What&apos;s happening
            </Typography>
          </Box>
          <Tooltip title={refreshing ? "Generating fresh summaries..." : "Generate fresh summaries"}>
            <IconButton
              size="small"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="Refresh summaries"
              sx={{
                opacity: refreshing ? 0.5 : 1,
                transition: 'opacity 0.3s ease'
              }}
            >
              <RefreshIcon 
                sx={{ 
                  fontSize: 18,
                  animation: refreshing ? 'spin 1s linear infinite' : 'none',
                  '@keyframes spin': {
                    '0%': { transform: 'rotate(0deg)' },
                    '100%': { transform: 'rotate(360deg)' }
                  }
                }} 
              />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {error ? (
        <Box sx={{ p: 2, textAlign: 'center' }}>
          <Typography variant="body2" color="error">
            Unable to load summaries
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {error}
          </Typography>
        </Box>
      ) : (
        <Box>
          <SummaryCard 
            summary={summaries.posts} 
            type="posts" 
            icon={<PostAddIcon sx={{ fontSize: 18, color: 'primary.main' }} />}
          />
          
          <Divider sx={{ mx: 2 }} />
          
          <SummaryCard 
            summary={summaries.chats} 
            type="chats" 
            icon={<ChatIcon sx={{ fontSize: 18, color: 'secondary.main' }} />}
          />

          {/* Active Pod Sections */}
          <PodSection 
            rooms={summaries.chatRooms}
            title="Active Chat Rooms"
            icon={<ChatIcon sx={{ fontSize: 16, mr: 0.5 }} />}
            podType="chat"
            color="info"
            sectionKey="chatRooms"
          />

          <PodSection 
            rooms={summaries.studyRooms}
            title="Active Study Groups"
            icon={<SchoolIcon sx={{ fontSize: 16, mr: 0.5 }} />}
            podType="study"
            color="success"
            sectionKey="studyRooms"
          />

          <PodSection 
            rooms={summaries.gameRooms}
            title="Active Game Rooms"
            icon={<SportsEsportsIcon sx={{ fontSize: 16, mr: 0.5 }} />}
            podType="games"
            color="warning"
            sectionKey="gameRooms"
          />

          {summaries.allPosts && (
            <>
              <Divider sx={{ mx: 2, my: 1 }} />
              <Box sx={{ px: 2, pb: 1 }}>
                <Typography 
                  variant="subtitle2" 
                  sx={{ 
                    fontWeight: 600, 
                    mb: 1, 
                    color: 'text.primary',
                    display: 'flex',
                    alignItems: 'center'
                  }}
                >
                  <PostAddIcon sx={{ fontSize: 16, mr: 0.5 }} />
                  Community Overview
                </Typography>
                <Card 
                  variant="outlined"
                  sx={{ 
                    borderLeft: '3px solid', 
                    borderLeftColor: 'primary.main',
                    backgroundColor: 'background.paper',
                    '&:hover': {
                      boxShadow: 1
                    }
                  }}
                >
                  <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                    <Typography 
                      variant="subtitle2" 
                      sx={{ 
                        fontWeight: 600,
                        mb: 0.5,
                        color: 'text.primary'
                      }}
                    >
                      {summaries.allPosts.title}
                    </Typography>
                    
                    <Typography 
                      variant="body2" 
                      sx={{ 
                        mb: 1,
                        lineHeight: 1.4,
                        color: 'text.secondary',
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden'
                      }}
                    >
                      {summaries.allPosts.content}
                    </Typography>
                    
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                      {summaries.allPosts.metadata?.totalItems > 0 && (
                        <Chip 
                          size="small" 
                          label={`${summaries.allPosts.metadata.totalItems} total posts`}
                          variant="outlined"
                          color="primary"
                          sx={{ fontSize: '0.65rem', height: 18 }}
                        />
                      )}
                      {summaries.allPosts.metadata?.topTags?.slice(0, 3).map((tag, index) => (
                        <Chip 
                          key={index}
                          size="small" 
                          label={`#${tag}`}
                          color="primary"
                          variant="filled"
                          sx={{ 
                            fontSize: '0.65rem', 
                            height: 18,
                            cursor: 'pointer',
                            '&:hover': {
                              backgroundColor: 'primary.dark',
                              transform: 'scale(1.02)'
                            },
                            transition: 'all 0.2s ease'
                          }}
                          onClick={() => handleTagClick(tag)}
                        />
                      ))}
                    </Box>
                  </CardContent>
                </Card>
              </Box>
            </>
          )}
        </Box>
      )}

      {!error && (summaries.posts || summaries.chats) && (
        <Box sx={{ p: 1.5, pt: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
            Summaries updated hourly using AI • Click refresh for fresh summaries
          </Typography>
        </Box>
      )}
    </Paper>
  );
};

export default WhatsHappening; 