import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNavigate, useParams } from 'react-router-dom';
import Pod from './Pod';
const axios = require('axios').default;

// Mock the entire @mui/material module
jest.mock('@mui/material', () => {
  const mockReact = require('react');
  
  // Store the current Tabs onChange handler globally
  let currentTabsOnChange = null;
  let tabCounter = 0;
  
  const MockComponent = (componentName) => {
    return mockReact.forwardRef((props, ref) => {
      // Filter out MUI-specific props that shouldn't be passed to DOM elements
      const {
        // Tab-specific props we need
        onChange, 'aria-label': ariaLabel, label,
        // Button-specific props we need
        onClick,
        // TextField-specific props we need
        placeholder, type,
        // Other props to keep
        children, className, style, 'data-testid': dataTestId
        // Filter out all other MUI props with rest operator
      } = props;

      // Create appropriate DOM element based on component type
      let elementType = 'div';
      let elementProps = {
        ref,
        className,
        style,
        'data-testid': dataTestId,
        'aria-label': ariaLabel
      };
      let content = children;

      if (componentName === 'Button' || componentName === 'IconButton') {
        elementType = 'button';
        elementProps.onClick = onClick;
        elementProps.role = 'button';
      } else if (componentName === 'TextField') {
        elementType = 'input';
        elementProps.placeholder = placeholder;
        elementProps.type = type || 'text';
        elementProps.role = 'textbox';
        elementProps.onChange = onChange;
        elementProps.value = props.value;
      } else if (componentName === 'Tab') {
        elementType = 'button';
        elementProps.role = 'tab';
        // Store tab index in data attribute
        const tabIndex = tabCounter++;
        elementProps['data-tab-index'] = tabIndex;
        elementProps.onClick = (event) => {
          console.log('Tab clicked:', event.target.textContent);
          // Use the globally stored onChange handler with the stored index
          if (currentTabsOnChange) {
            const clickedTabIndex = parseInt(event.target.getAttribute('data-tab-index'));
            console.log('Triggering onChange with index:', clickedTabIndex);
            currentTabsOnChange(event, clickedTabIndex);
          }
          if (onClick) onClick(event);
        };
        elementProps['aria-label'] = ariaLabel;
        // Use label prop as content for Tab components
        content = label || children;
      } else if (componentName === 'Tabs') {
        elementType = 'div';
        elementProps.role = 'tablist';
        // Store the onChange function globally and reset tab counter
        if (onChange) {
          currentTabsOnChange = onChange;
          tabCounter = 0; // Reset counter for each Tabs component
        }
      }

      return mockReact.createElement(elementType, elementProps, content);
    });
  };

  return {
    Container: MockComponent('Container'),
    Typography: MockComponent('Typography'),
    Button: MockComponent('Button'),
    TextField: MockComponent('TextField'),
    Box: MockComponent('Box'),
    Grid: MockComponent('Grid'),
    Paper: MockComponent('Paper'),
    Card: MockComponent('Card'),
    CardContent: MockComponent('CardContent'),
    CardActions: MockComponent('CardActions'),
    Tabs: MockComponent('Tabs'),
    Tab: MockComponent('Tab'),
    Badge: MockComponent('Badge'),
    Chip: MockComponent('Chip'),
    Avatar: MockComponent('Avatar'),
    List: MockComponent('List'),
    ListItem: MockComponent('ListItem'),
    ListItemText: MockComponent('ListItemText'),
    Divider: MockComponent('Divider'),
    CircularProgress: MockComponent('CircularProgress'),
    Alert: MockComponent('Alert'),
    Snackbar: MockComponent('Snackbar'),
    Dialog: MockComponent('Dialog'),
    DialogTitle: MockComponent('DialogTitle'),
    DialogContent: MockComponent('DialogContent'),
    DialogActions: MockComponent('DialogActions'),
    AppBar: MockComponent('AppBar'),
    Toolbar: MockComponent('Toolbar'),
    IconButton: MockComponent('IconButton'),
    Menu: MockComponent('Menu'),
    MenuItem: MockComponent('MenuItem'),
    FormControl: MockComponent('FormControl'),
    InputLabel: MockComponent('InputLabel'),
    Select: MockComponent('Select'),
    Switch: MockComponent('Switch'),
    Checkbox: MockComponent('Checkbox'),
    Radio: MockComponent('Radio'),
    RadioGroup: MockComponent('RadioGroup'),
    FormControlLabel: MockComponent('FormControlLabel'),
    Slider: MockComponent('Slider'),
    Accordion: MockComponent('Accordion'),
    AccordionSummary: MockComponent('AccordionSummary'),
    AccordionDetails: MockComponent('AccordionDetails'),
    Tooltip: MockComponent('Tooltip'),
    Popover: MockComponent('Popover'),
    Modal: MockComponent('Modal'),
    Backdrop: MockComponent('Backdrop'),
    Drawer: MockComponent('Drawer'),
    BottomNavigation: MockComponent('BottomNavigation'),
    BottomNavigationAction: MockComponent('BottomNavigationAction'),
    Stepper: MockComponent('Stepper'),
    Step: MockComponent('Step'),
    StepLabel: MockComponent('StepLabel'),
    StepContent: MockComponent('StepContent'),
    Table: MockComponent('Table'),
    TableBody: MockComponent('TableBody'),
    TableCell: MockComponent('TableCell'),
    TableContainer: MockComponent('TableContainer'),
    TableHead: MockComponent('TableHead'),
    TableRow: MockComponent('TableRow'),
    Pagination: MockComponent('Pagination'),
    Breadcrumbs: MockComponent('Breadcrumbs'),
    Link: MockComponent('Link'),
    Stack: MockComponent('Stack'),
    Collapse: MockComponent('Collapse')
  };
});

// Mock @mui/icons-material
jest.mock('@mui/icons-material', () => {
  const mockReact = require('react');
  return {
    Add: () => mockReact.createElement('span', { 'data-testid': 'add-icon' }, '+'),
    Search: () => mockReact.createElement('span', { 'data-testid': 'search-icon' }, '🔍'),
    People: () => mockReact.createElement('span', { 'data-testid': 'people-icon' }, '👥'),
    Chat: () => mockReact.createElement('span', { 'data-testid': 'chat-icon' }, '💬'),
    School: () => mockReact.createElement('span', { 'data-testid': 'school-icon' }, '🎓'),
    Work: () => mockReact.createElement('span', { 'data-testid': 'work-icon' }, '💼'),
    FilterList: () => mockReact.createElement('span', { 'data-testid': 'filter-icon' }, '📋'),
    MoreVert: () => mockReact.createElement('span', { 'data-testid': 'more-icon' }, '⋮'),
    Close: () => mockReact.createElement('span', { 'data-testid': 'close-icon' }, '✕'),
    Check: () => mockReact.createElement('span', { 'data-testid': 'check-icon' }, '✓'),
    Delete: () => mockReact.createElement('span', { 'data-testid': 'delete-icon' }, '🗑'),
    DeleteOutline: () => mockReact.createElement('span', { 'data-testid': 'delete-outline-icon' }, '🗑'),
    Edit: () => mockReact.createElement('span', { 'data-testid': 'edit-icon' }, '✏️'),
    Share: () => mockReact.createElement('span', { 'data-testid': 'share-icon' }, '📤'),
    Favorite: () => mockReact.createElement('span', { 'data-testid': 'favorite-icon' }, '❤️'),
    Star: () => mockReact.createElement('span', { 'data-testid': 'star-icon' }, '⭐'),
    Home: () => mockReact.createElement('span', { 'data-testid': 'home-icon' }, '🏠'),
    Settings: () => mockReact.createElement('span', { 'data-testid': 'settings-icon' }, '⚙️'),
    AccountCircle: () => mockReact.createElement('span', { 'data-testid': 'account-icon' }, '👤'),
    Notifications: () => mockReact.createElement('span', { 'data-testid': 'notifications-icon' }, '🔔'),
    Menu: () => mockReact.createElement('span', { 'data-testid': 'menu-icon' }, '☰'),
    ArrowBack: () => mockReact.createElement('span', { 'data-testid': 'arrow-back-icon' }, '←'),
    ArrowForward: () => mockReact.createElement('span', { 'data-testid': 'arrow-forward-icon' }, '→'),
    ExpandMore: () => mockReact.createElement('span', { 'data-testid': 'expand-more-icon' }, '▼'),
    ExpandLess: () => mockReact.createElement('span', { 'data-testid': 'expand-less-icon' }, '▲'),
    Refresh: () => mockReact.createElement('span', { 'data-testid': 'refresh-icon' }, '🔄'),
    TrendingUp: () => mockReact.createElement('span', { 'data-testid': 'trending-up-icon' }, '📈'),
    PostAdd: () => mockReact.createElement('span', { 'data-testid': 'post-add-icon' }, '📝'),
    SportsEsports: () => mockReact.createElement('span', { 'data-testid': 'sports-esports-icon' }, '🎮'),
    Launch: () => mockReact.createElement('span', { 'data-testid': 'launch-icon' }, '🚀'),
    Whatshot: () => mockReact.createElement('span', { 'data-testid': 'whatshot-icon' }, '🔥'),
    Lightbulb: () => mockReact.createElement('span', { 'data-testid': 'lightbulb-icon' }, '💡')
  };
});

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), delete: jest.fn() }
}));
jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: jest.fn(),
  useParams: jest.fn()
}));

beforeEach(() => {
  jest.resetAllMocks();
  localStorage.setItem('token', 't');
  useAuth.mockReturnValue({ currentUser: { _id: 'u1' } });
  useNavigate.mockReturnValue(jest.fn());
  useParams.mockReturnValue({ podType: 'chat' });
});

afterEach(() => {
  localStorage.clear();
});

const mockPod = {
  _id: '1',
  name: 'Room',
  description: 'Desc',
  type: 'chat',
  createdBy: { _id: 'owner-1', username: 'a' },
  members: []
};

const renderPodWithRouter = (component) => {
  return render(
    <BrowserRouter>
      {component}
    </BrowserRouter>
  );
};

test('fetches pods and displays them', async () => {
  axios.get.mockResolvedValueOnce({ data: [mockPod] });
  
  renderPodWithRouter(<Pod />);
  
  await waitFor(() => {
    expect(axios.get).toHaveBeenCalledWith('/api/pods/chat');
  });
  
  await waitFor(() => {
    expect(screen.getByText('Room')).toBeInTheDocument();
  });
});

test('join button posts and navigates', async () => {
  const navigate = jest.fn();
  useNavigate.mockReturnValue(navigate);
  axios.get.mockResolvedValueOnce({ data: [mockPod] });
  axios.post.mockResolvedValue({ data: mockPod });
  
  renderPodWithRouter(<Pod />);
  
  await waitFor(() => {
    expect(screen.getByText('Room')).toBeInTheDocument();
  });
  
  const joinBtn = screen.getByText('Join Room');
  fireEvent.click(joinBtn);
  
  await waitFor(() => {
    expect(axios.post).toHaveBeenCalledWith(
      '/api/pods/1/join',
      {},
      { headers: { Authorization: 'Bearer t' } }
    );
  });
  
  await waitFor(() => {
    expect(navigate).toHaveBeenCalledWith('/pods/chat/1');
  });
});

test('tab change navigates', async () => {
  const mockNavigate = jest.fn();
  useNavigate.mockReturnValue(mockNavigate);
  
  renderPodWithRouter(<Pod />);
  
  await waitFor(() => {
    expect(screen.getByText('Pods')).toBeInTheDocument();
  });
  
  // Get all tabs and click the second one (Study tab)
  const tabs = screen.getAllByRole('tab');
  expect(tabs).toHaveLength(4); // Chat, Study, Games, Ensemble
  
  const studyTab = tabs[1]; // Study is the second tab
  expect(studyTab).toHaveTextContent('Study');
  
  fireEvent.click(studyTab);
  
  // Wait for the navigation to be called
  await waitFor(() => {
    expect(mockNavigate).toHaveBeenCalledWith('/pods/study');
  });

  const ensembleTab = tabs[3];
  expect(ensembleTab).toHaveTextContent('Ensemble');
  fireEvent.click(ensembleTab);

  await waitFor(() => {
    expect(mockNavigate).toHaveBeenCalledWith('/pods/agent-ensemble');
  });
});

test('search filters pods', async () => {
  const pod2 = { ...mockPod, _id: '2', name: 'Other', description: 'Desc', type: 'chat' };
  axios.get.mockResolvedValueOnce({ data: [mockPod, pod2] });
  
  renderPodWithRouter(<Pod />);
  
  await waitFor(() => {
    expect(screen.getByText('Room')).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
  });
  
  const searchInput = screen.getByPlaceholderText('Search pods...');
  fireEvent.change(searchInput, { target: { value: 'Other' } });
  
  await waitFor(() => {
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.queryByText('Room')).not.toBeInTheDocument();
  });
  
  fireEvent.change(searchInput, { target: { value: 'None' } });
  
  await waitFor(() => {
    expect(screen.getByText('No pods found in this category')).toBeInTheDocument();
  });
});

test('global admin sees delete button for a pod they did not create', async () => {
  useAuth.mockReturnValue({ currentUser: { _id: 'admin-1', role: 'admin' } });
  axios.get.mockResolvedValueOnce({ data: [mockPod] });

  renderPodWithRouter(<Pod />);

  await waitFor(() => {
    expect(screen.getByText('Room')).toBeInTheDocument();
  });

  expect(screen.getByLabelText('Delete pod')).toBeInTheDocument();
});

test('joined filter only shows pods where the user is a member', async () => {
  const joinedPod = {
    ...mockPod,
    _id: 'joined-1',
    name: 'Joined Room',
    members: ['u1']
  };
  const discoverPod = {
    ...mockPod,
    _id: 'discover-1',
    name: 'Discover Room',
    members: ['another-user']
  };
  axios.get.mockResolvedValueOnce({ data: [joinedPod, discoverPod] });

  renderPodWithRouter(<Pod />);

  await waitFor(() => {
    expect(screen.getByText('Joined Room')).toBeInTheDocument();
    expect(screen.getByText('Discover Room')).toBeInTheDocument();
  });

  fireEvent.click(screen.getByText('Joined'));

  await waitFor(() => {
    expect(screen.getByText('Joined Room')).toBeInTheDocument();
    expect(screen.queryByText('Discover Room')).not.toBeInTheDocument();
  });
});

test('pod overview shows max four member avatars with overflow and role summary', async () => {
  const members = [
    { _id: 'owner-1', username: 'owner' },
    { _id: 'agent-1', username: 'openclaw-liz' },
    { _id: 'm-1', username: 'alice' },
    { _id: 'm-2', username: 'bob' },
    { _id: 'm-3', username: 'charlie' },
  ];
  axios.get.mockResolvedValueOnce({
    data: [{
      ...mockPod,
      name: 'Preview Pod',
      createdBy: { _id: 'owner-1', username: 'owner' },
      members,
    }],
  });

  renderPodWithRouter(<Pod />);

  await waitFor(() => {
    expect(screen.getByText('Preview Pod')).toBeInTheDocument();
  });

  expect(screen.getByText('+1')).toBeInTheDocument();
  expect(screen.getByText(/1 admin • 1 agent • 3 members/i)).toBeInTheDocument();
});

test('joined pod card shows unread visual state when new messages exist', async () => {
  const joinedPod = {
    ...mockPod,
    _id: 'joined-unread',
    name: 'Unread Pod',
    members: ['u1']
  };
  localStorage.setItem('podLastRead:u1:joined-unread', String(new Date('2024-01-01T00:00:00.000Z').getTime()));
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods/chat') {
      return Promise.resolve({ data: [joinedPod] });
    }
    if (url === '/api/messages/joined-unread?limit=1') {
      return Promise.resolve({
        data: [{ createdAt: '2024-01-01T01:00:00.000Z' }]
      });
    }
    return Promise.resolve({ data: [] });
  });

  const { container } = renderPodWithRouter(<Pod />);

  await waitFor(() => {
    expect(screen.getByText('Unread Pod')).toBeInTheDocument();
  });

  await waitFor(() => {
    expect(container.querySelector('.pod-card-unread')).toBeInTheDocument();
  });
});

test('agent-admin listing uses DM-specific header and empty state', async () => {
  useParams.mockReturnValue({ podType: 'agent-admin' });
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods/agent-admin') {
      return Promise.resolve({ data: [] });
    }
    if (url === '/api/pods?type=agent-admin') {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ data: [] });
  });

  renderPodWithRouter(<Pod />);

  await waitFor(() => {
    expect(screen.getByText('Agent DMs')).toBeInTheDocument();
  });

  expect(screen.getByText('Direct message conversations with your installed agents.')).toBeInTheDocument();
  expect(screen.getByText('No agent DMs yet')).toBeInTheDocument();
  expect(screen.getByText('Open a DM from the Agents page.')).toBeInTheDocument();
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
  expect(screen.queryByText('Joined')).not.toBeInTheDocument();
  expect(screen.queryByText('Discover')).not.toBeInTheDocument();
});
