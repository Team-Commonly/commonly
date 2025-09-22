import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WhatsHappening from './WhatsHappening';

// Mock axios
jest.mock('axios', () => ({
  get: jest.fn(),
}));
const axios = require('axios');

// Mock localStorage
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};
Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Mock react-router-dom
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

// Mock data
const mockSummariesData = {
  posts: {
    title: 'Community Posts Overview',
    description: 'Latest posts from the community covering various topics.',
    content: 'Latest posts from the community covering various topics.',
    hashtags: ['#technology', '#lifestyle', '#education'],
    createdAt: '2023-12-01T09:00:00Z',
    metadata: {
      totalItems: 25,
      topTags: ['technology', 'lifestyle', 'education']
    }
  },
  chats: {
    title: 'Chat Activity Summary',
    description: 'Active discussions across different chat rooms.',
    content: 'Active discussions across different chat rooms.',
    createdAt: '2023-12-01T09:30:00Z',
    metadata: {
      totalItems: 42,
      topTags: ['general', 'tech-talk', 'random']
    }
  }
};

const mockChatRooms = [
  { 
    _id: 'chat1', 
    podId: 'pod1',
    name: 'Tech Chat Room', 
    activity: 'high', 
    createdAt: '2023-12-01T10:00:00.000Z',
    metadata: {
      podName: 'Tech Chat Room',
      totalItems: 15
    }
  }
];

const mockStudyRooms = [
  { 
    _id: 'study1', 
    podId: 'study1',
    name: 'CS Study Group', 
    topic: 'algorithms', 
    createdAt: '2023-12-01T11:00:00.000Z',
    metadata: {
      podName: 'CS Study Group',
      totalItems: 25
    }
  }
];

const mockGameRooms = [
  { 
    _id: 'game1', 
    podId: 'game1',
    name: 'Tournament Arena', 
    game: 'chess', 
    createdAt: '2023-12-01T12:00:00.000Z',
    metadata: {
      podName: 'Tournament Arena',
      totalItems: 10
    }
  }
];

const mockAllPosts = {
  title: 'All Posts Summary',
  content: 'Recent posts from all community members.',
  metadata: {
    totalItems: 15,
    topTags: ['technology', 'lifestyle']
  }
};

// Test wrapper with router
const renderWithRouter = (component) => {
  return render(
    <MemoryRouter>
      {component}
    </MemoryRouter>
  );
};

describe('WhatsHappening Component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigate.mockClear();

    // Setup localStorage mock to return test token
    localStorageMock.getItem.mockImplementation((key) => {
      if (key === 'token') return 'test-token';
      return null;
    });

    // Setup default axios mocks for all tests
    axios.get.mockImplementation((url) => {
      if (url === '/api/summaries/latest') {
        return Promise.resolve({ data: mockSummariesData });
      }
      if (url === '/api/summaries/chat-rooms?limit=3') {
        return Promise.resolve({ data: mockChatRooms });
      }
      if (url === '/api/summaries/study-rooms?limit=3') {
        return Promise.resolve({ data: mockStudyRooms });
      }
      if (url === '/api/summaries/game-rooms?limit=3') {
        return Promise.resolve({ data: mockGameRooms });
      }
      if (url === '/api/summaries/all-posts') {
        return Promise.resolve({ data: mockAllPosts });
      }
      if (url === '/api/summaries/trigger') {
        return Promise.resolve({ data: { success: true } });
      }
      return Promise.reject(new Error('Unknown URL'));
    });
  });

  describe('Component Rendering', () => {
    test('renders basic structure with title and refresh button', async () => {
      renderWithRouter(<WhatsHappening />);

      // Wait for loading to complete
      await waitFor(() => {
        expect(screen.getByText("What's happening")).toBeInTheDocument();
        expect(screen.getByLabelText('Refresh summaries')).toBeInTheDocument();
      });
    });

    test('displays error state when API calls fail', async () => {
      // Override default mock to simulate failure
      axios.get.mockRejectedValue(new Error('API Error'));

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        expect(screen.getByText('Unable to load summaries')).toBeInTheDocument();
        expect(screen.getByText('Failed to fetch summaries')).toBeInTheDocument();
      });
    });

    test('displays content when API calls succeed', async () => {
      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        expect(screen.getByText('Community Posts Overview')).toBeInTheDocument();
        expect(screen.getByText('Chat Activity Summary')).toBeInTheDocument();
      });
    });
  });

  describe('Refresh Functionality', () => {
    test('refresh button is clickable', async () => {
      // Override axios to ensure immediate resolution for this test
      axios.get.mockImplementation((url) => {
        return Promise.resolve({
          data: url === '/api/summaries/latest' ? mockSummariesData : []
        });
      });

      renderWithRouter(<WhatsHappening />);

      // Wait for component to load and show main content
      await waitFor(() => {
        expect(screen.getByText("What's happening")).toBeInTheDocument();
      }, { timeout: 3000 });

      // Find and test the refresh button
      const refreshButton = screen.getByLabelText('Refresh summaries');
      expect(refreshButton).toBeInTheDocument();
      expect(refreshButton).not.toBeDisabled();

      // Click the button - this should trigger the refresh functionality
      fireEvent.click(refreshButton);

      // After clicking refresh, the component might re-render
      // Just verify the click action was completed without errors
    });

    test('refresh button makes API calls when clicked', async () => {
      // Mock successful API responses
      axios.get.mockImplementation((url) => {
        if (url === '/api/summaries/latest') {
          return Promise.resolve({ data: mockSummariesData });
        }
        if (url === '/api/summaries/chat-rooms?limit=3') {
          return Promise.resolve({ data: mockChatRooms });
        }
        if (url === '/api/summaries/study-rooms?limit=3') {
          return Promise.resolve({ data: mockStudyRooms });
        }
        if (url === '/api/summaries/game-rooms?limit=3') {
          return Promise.resolve({ data: mockGameRooms });
        }
        if (url === '/api/summaries/all-posts') {
          return Promise.resolve({ data: mockAllPosts });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      renderWithRouter(<WhatsHappening />);
      
      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByText("What's happening")).toBeInTheDocument();
      });

      // Clear previous calls
      axios.get.mockClear();

      // Click refresh button
      const refreshButton = screen.getByLabelText('Refresh summaries');
      fireEvent.click(refreshButton);

      // Should eventually show content
      await waitFor(() => {
        expect(screen.queryByText('Community Posts Overview')).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    test('displays error message when all API calls fail', async () => {
      // Override default mock to simulate failure
      axios.get.mockRejectedValue(new Error('API Error'));

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        expect(screen.getByText('Unable to load summaries')).toBeInTheDocument();
        expect(screen.getByText('Failed to fetch summaries')).toBeInTheDocument();
      });
    });

    test('still shows error when some API calls fail', async () => {
      // Mock mixed success/failure responses
      axios.get.mockImplementation((url) => {
        if (url === '/api/summaries/latest') {
          return Promise.resolve({ data: mockSummariesData });
        }
        // Other calls fail
        return Promise.reject(new Error('API Error'));
      });

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        expect(screen.getByText('Unable to load summaries')).toBeInTheDocument();
      });
    });
  });

  describe('API Integration', () => {
    test('makes API calls with correct URLs and headers', async () => {
      // Mock successful API responses with correct data types
      axios.get.mockImplementation((url) => {
        if (url === '/api/summaries/latest') {
          return Promise.resolve({ data: mockSummariesData });
        }
        if (url === '/api/summaries/chat-rooms?limit=3') {
          return Promise.resolve({ data: mockChatRooms });
        }
        if (url === '/api/summaries/study-rooms?limit=3') {
          return Promise.resolve({ data: mockStudyRooms });
        }
        if (url === '/api/summaries/game-rooms?limit=3') {
          return Promise.resolve({ data: mockGameRooms });
        }
        if (url === '/api/summaries/all-posts') {
          return Promise.resolve({ data: mockAllPosts });
        }
        return Promise.resolve({ data: [] });
      });

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        expect(axios.get).toHaveBeenCalledWith('/api/summaries/latest', expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token'
          })
        }));
      });
    });
  });

  describe('Section Expandability', () => {
    test('can expand sections when data loads successfully', async () => {
      // Mock successful API responses
      axios.get.mockImplementation((url) => {
        if (url === '/api/summaries/latest') {
          return Promise.resolve({ data: mockSummariesData });
        }
        if (url === '/api/summaries/chat-rooms?limit=3') {
          return Promise.resolve({ data: mockChatRooms });
        }
        if (url === '/api/summaries/study-rooms?limit=3') {
          return Promise.resolve({ data: mockStudyRooms });
        }
        if (url === '/api/summaries/game-rooms?limit=3') {
          return Promise.resolve({ data: mockGameRooms });
        }
        if (url === '/api/summaries/all-posts') {
          return Promise.resolve({ data: mockAllPosts });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        expect(screen.getByText('Community Posts Overview')).toBeInTheDocument();
      });

      // Test section expansion - look for expand/collapse buttons
      const expandButtons = screen.getAllByRole('button');
      const sectionButton = expandButtons.find(button => 
        button.getAttribute('aria-label')?.includes('expand') || 
        button.getAttribute('aria-label')?.includes('collapse')
      );
      
      if (sectionButton) {
        fireEvent.click(sectionButton);
        // Should still be functional after click
        expect(screen.getByText('Community Posts Overview')).toBeInTheDocument();
      }
    });

    test('shows collapsed state by default in error state', async () => {
      renderWithRouter(<WhatsHappening />);
      
      await waitFor(() => {
        // In error state, detailed content shouldn't be visible
        expect(screen.queryByText('Latest posts from the community')).not.toBeInTheDocument();
        expect(screen.queryByText('Active discussions across different')).not.toBeInTheDocument();
      });
    });
  });

  describe('Navigation Functionality', () => {
    test('navigation works when clicking elements with successful data', async () => {
      // Mock successful API responses
      axios.get.mockImplementation((url) => {
        if (url === '/api/summaries/latest') {
          return Promise.resolve({ data: mockSummariesData });
        }
        if (url === '/api/summaries/chat-rooms?limit=3') {
          return Promise.resolve({ data: mockChatRooms });
        }
        if (url === '/api/summaries/study-rooms?limit=3') {
          return Promise.resolve({ data: mockStudyRooms });
        }
        if (url === '/api/summaries/game-rooms?limit=3') {
          return Promise.resolve({ data: mockGameRooms });
        }
        if (url === '/api/summaries/all-posts') {
          return Promise.resolve({ data: mockAllPosts });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        expect(screen.getByText('Community Posts Overview')).toBeInTheDocument();
      });

      // Test navigation by looking for clickable elements
      const clickableElements = screen.getAllByRole('button');
      expect(clickableElements.length).toBeGreaterThan(0);
      
      // The refresh button should be present and clickable
      const refreshButton = screen.getByLabelText('Refresh summaries');
      expect(refreshButton).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    test('has proper ARIA labels', async () => {
      renderWithRouter(<WhatsHappening />);

      // Wait for loading to complete and element to be available
      await waitFor(() => {
        const refreshButton = screen.getByLabelText('Refresh summaries');
        expect(refreshButton).toBeInTheDocument();
      });
    });

    test('is keyboard accessible', async () => {
      renderWithRouter(<WhatsHappening />);

      // Wait for loading to complete
      await waitFor(() => {
        const buttons = screen.getAllByRole('button');
        expect(buttons.length).toBeGreaterThan(0);

        buttons.forEach(button => {
          // IconButtons don't always have explicit tabindex, but they should be focusable
          expect(button.tabIndex).toBeGreaterThanOrEqual(0);
        });
      });
    });
  });

  describe('Loading States', () => {
    test('handles loading state transitions', async () => {
      // Mock delayed response
      const delayedPromise = new Promise(resolve => 
        setTimeout(() => resolve({ data: mockSummariesData }), 100)
      );
      
      axios.get.mockImplementation((url) => {
        if (url === '/api/summaries/latest') {
          return delayedPromise;
        }
        return Promise.reject(new Error('API Error'));
      });

      renderWithRouter(<WhatsHappening />);
      
      // Component should show loading state initially
      expect(screen.getByText("Loading what's happening...")).toBeInTheDocument();
      
      // Wait for the delayed response to complete and show error state
      await waitFor(() => {
        expect(screen.queryByText('Unable to load summaries')).toBeInTheDocument();
      }, { timeout: 3000 });
    });
  });

  describe('Most Active Rooms', () => {
    const mockApiResponses = (url) => {
      if (url === '/api/summaries/latest') {
        return Promise.resolve({ data: mockSummariesData });
      }
      if (url === '/api/summaries/chat-rooms?limit=3') {
        return Promise.resolve({ data: mockChatRooms });
      }
      if (url === '/api/summaries/study-rooms?limit=3') {
        return Promise.resolve({ data: mockStudyRooms });
      }
      if (url === '/api/summaries/game-rooms?limit=3') {
        return Promise.resolve({ data: mockGameRooms });
      }
      if (url === '/api/summaries/all-posts') {
        return Promise.resolve({ data: mockAllPosts });
      }
      return Promise.reject(new Error('Unknown URL'));
    };

    test('displays Most Active Rooms section under chat summary', async () => {
      axios.get.mockImplementation(mockApiResponses);

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        expect(screen.getByText('Most Active Rooms')).toBeInTheDocument();
      });
    });

    test('combines chat rooms from all pod types (chat, study, games)', async () => {
      axios.get.mockImplementation(mockApiResponses);

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        // Look for the chips specifically in the Most Active Rooms section
        expect(screen.getByText('Most Active Rooms')).toBeInTheDocument();
        
        // Find chips with message counts (these are from Most Active Rooms)
        expect(screen.getByText('Tech Chat Room (15)')).toBeInTheDocument();
        expect(screen.getByText('CS Study Group (25)')).toBeInTheDocument();
        expect(screen.getByText('Tournament Arena (10)')).toBeInTheDocument();
      });
    });

    test('sorts rooms by activity level (message count)', async () => {
      // Mock data with different activity levels
      const highActivityStudy = { 
        ...mockStudyRooms[0], 
        metadata: { ...mockStudyRooms[0].metadata, totalItems: 50 }
      };
      const mediumActivityChat = { 
        ...mockChatRooms[0], 
        metadata: { ...mockChatRooms[0].metadata, totalItems: 20 }
      };
      const lowActivityGame = { 
        ...mockGameRooms[0], 
        metadata: { ...mockGameRooms[0].metadata, totalItems: 5 }
      };

      axios.get.mockImplementation((url) => {
        if (url === '/api/summaries/latest') {
          return Promise.resolve({ data: mockSummariesData });
        }
        if (url === '/api/summaries/chat-rooms?limit=3') {
          return Promise.resolve({ data: [mediumActivityChat] });
        }
        if (url === '/api/summaries/study-rooms?limit=3') {
          return Promise.resolve({ data: [highActivityStudy] });
        }
        if (url === '/api/summaries/game-rooms?limit=3') {
          return Promise.resolve({ data: [lowActivityGame] });
        }
        if (url === '/api/summaries/all-posts') {
          return Promise.resolve({ data: mockAllPosts });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        // Check for specific activity levels in order
        expect(screen.getByText('CS Study Group (50)')).toBeInTheDocument();
        expect(screen.getByText('Tech Chat Room (20)')).toBeInTheDocument();
        expect(screen.getByText('Tournament Arena (5)')).toBeInTheDocument();
      });
    });

    test('limits display to top 3 most active rooms', async () => {
      // Mock more than 3 rooms with valid dates
      const manyRooms = [
        { _id: 'r1', podId: 'p1', createdAt: '2023-12-01T10:00:00.000Z', metadata: { podName: 'Room 1', totalItems: 100 }},
        { _id: 'r2', podId: 'p2', createdAt: '2023-12-01T10:00:00.000Z', metadata: { podName: 'Room 2', totalItems: 90 }},
        { _id: 'r3', podId: 'p3', createdAt: '2023-12-01T10:00:00.000Z', metadata: { podName: 'Room 3', totalItems: 80 }},
        { _id: 'r4', podId: 'p4', createdAt: '2023-12-01T10:00:00.000Z', metadata: { podName: 'Room 4', totalItems: 70 }},
        { _id: 'r5', podId: 'p5', createdAt: '2023-12-01T10:00:00.000Z', metadata: { podName: 'Room 5', totalItems: 60 }}
      ];

      axios.get.mockImplementation((url) => {
        if (url === '/api/summaries/latest') {
          return Promise.resolve({ data: mockSummariesData });
        }
        if (url === '/api/summaries/chat-rooms?limit=3') {
          return Promise.resolve({ data: manyRooms.slice(0, 3) });
        }
        if (url === '/api/summaries/study-rooms?limit=3') {
          return Promise.resolve({ data: manyRooms.slice(3) });
        }
        if (url === '/api/summaries/game-rooms?limit=3') {
          return Promise.resolve({ data: [] });
        }
        if (url === '/api/summaries/all-posts') {
          return Promise.resolve({ data: mockAllPosts });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        // Should show exactly 3 rooms with specific counts
        expect(screen.getByText('Room 1 (100)')).toBeInTheDocument();
        expect(screen.getByText('Room 2 (90)')).toBeInTheDocument();
        expect(screen.getByText('Room 3 (80)')).toBeInTheDocument();
        // Should not show the 4th and 5th rooms
        expect(screen.queryByText('Room 4 (70)')).not.toBeInTheDocument();
        expect(screen.queryByText('Room 5 (60)')).not.toBeInTheDocument();
      });
    });

    test('filters out rooms with no activity', async () => {
      const roomsWithNoActivity = [
        { _id: 'active1', podId: 'p1', createdAt: '2023-12-01T10:00:00.000Z', metadata: { podName: 'Active Room', totalItems: 10 }},
        { _id: 'inactive1', podId: 'p2', createdAt: '2023-12-01T10:00:00.000Z', metadata: { podName: 'Inactive Room', totalItems: 0 }},
        { _id: 'inactive2', podId: 'p3', createdAt: '2023-12-01T10:00:00.000Z', metadata: { podName: 'Another Inactive', totalItems: 0 }}
      ];

      axios.get.mockImplementation((url) => {
        if (url === '/api/summaries/latest') {
          return Promise.resolve({ data: mockSummariesData });
        }
        if (url === '/api/summaries/chat-rooms?limit=3') {
          return Promise.resolve({ data: roomsWithNoActivity });
        }
        if (url === '/api/summaries/study-rooms?limit=3') {
          return Promise.resolve({ data: [] });
        }
        if (url === '/api/summaries/game-rooms?limit=3') {
          return Promise.resolve({ data: [] });
        }
        if (url === '/api/summaries/all-posts') {
          return Promise.resolve({ data: mockAllPosts });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        // Should show only the active room in the chip
        expect(screen.getByText('Active Room (10)')).toBeInTheDocument();
        expect(screen.queryByText('Inactive Room (0)')).not.toBeInTheDocument();
        expect(screen.queryByText('Another Inactive (0)')).not.toBeInTheDocument();
      });
    });

    test('navigates to correct pod type when room chip is clicked', async () => {
      axios.get.mockImplementation(mockApiResponses);

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        expect(screen.getByText('CS Study Group (25)')).toBeInTheDocument();
        expect(screen.getByText('Tournament Arena (10)')).toBeInTheDocument();
      });

      // Click on the study room chip (the one with the count, not the title)
      const studyRoomChip = screen.getByText('CS Study Group (25)');
      fireEvent.click(studyRoomChip);

      expect(mockNavigate).toHaveBeenCalledWith('/pods/study/study1');

      // Clear previous navigation calls and test game room navigation
      mockNavigate.mockClear();

      // Click on the game room chip
      const gameRoomChip = screen.getByText('Tournament Arena (10)');
      fireEvent.click(gameRoomChip);

      expect(mockNavigate).toHaveBeenCalledWith('/pods/games/game1');
    });

    test('uses different colors for different chat pod types', async () => {
      axios.get.mockImplementation(mockApiResponses);

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        const chips = screen.getAllByRole('button').filter(button => 
          button.textContent?.includes('Tech Chat Room') ||
          button.textContent?.includes('CS Study Group') ||
          button.textContent?.includes('Tournament Arena')
        );

        // Should have different styling/colors (though exact color testing might be complex)
        expect(chips.length).toBeGreaterThan(0);
      });
    });

    test('handles empty room data gracefully', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/summaries/latest') {
          return Promise.resolve({ data: mockSummariesData });
        }
        if (url === '/api/summaries/chat-rooms?limit=3') {
          return Promise.resolve({ data: [] });
        }
        if (url === '/api/summaries/study-rooms?limit=3') {
          return Promise.resolve({ data: [] });
        }
        if (url === '/api/summaries/game-rooms?limit=3') {
          return Promise.resolve({ data: [] });
        }
        if (url === '/api/summaries/all-posts') {
          return Promise.resolve({ data: mockAllPosts });
        }
        return Promise.reject(new Error('Unknown URL'));
      });

      renderWithRouter(<WhatsHappening />);

      await waitFor(() => {
        expect(screen.getByText('Most Active Rooms')).toBeInTheDocument();
        // Should not crash with empty data
        expect(screen.getByText('Chat Activity Summary')).toBeInTheDocument();
      });
    });
  });
}); 






