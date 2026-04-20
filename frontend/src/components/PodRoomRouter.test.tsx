// @ts-nocheck
import React from 'react';
import { render, screen } from '@testing-library/react';
import { useParams } from 'react-router-dom';
import PodRoomRouter from './PodRoomRouter';

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: jest.fn(),
}));

jest.mock('./ChatRoom', () => {
  const MockChatRoom = () => <div>chat-room-view</div>;
  MockChatRoom.displayName = 'MockChatRoom';
  return MockChatRoom;
});
jest.mock('./ProjectPodRoom', () => {
  const MockProjectPodRoom = () => <div>project-pod-view</div>;
  MockProjectPodRoom.displayName = 'MockProjectPodRoom';
  return MockProjectPodRoom;
});

describe('PodRoomRouter', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  test('routes project pods to the dedicated project room', () => {
    useParams.mockReturnValue({ podType: 'project' });
    render(<PodRoomRouter />);
    expect(screen.getByText('project-pod-view')).toBeInTheDocument();
  });

  test('routes non-project pods to the legacy chat room', () => {
    useParams.mockReturnValue({ podType: 'chat' });
    render(<PodRoomRouter />);
    expect(screen.getByText('chat-room-view')).toBeInTheDocument();
  });
});
