// @ts-nocheck
/**
 * AgentCard Tests
 *
 * Verifies rendering of agent cards in different states: default, installed,
 * with "Talk to" button, and the skeleton loading variant.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AgentCard from './AgentCard';

// Minimal agent fixture
const baseAgent = {
  _id: 'agent-1',
  name: 'task-clerk',
  displayName: 'Task Clerk',
  agentName: 'task-clerk',
  description: 'Captures action items from chat as tasks.',
  type: 'productivity',
  categories: ['productivity'],
  capabilities: ['task creation', 'context reading'],
  stats: { installs: 42, podsJoined: 3, messagesProcessed: 1200 },
};

describe('AgentCard', () => {
  it('renders agent name and description', () => {
    render(<AgentCard agent={baseAgent} />);
    expect(screen.getByText('Task Clerk')).toBeInTheDocument();
    expect(screen.getByText(/Captures action items/)).toBeInTheDocument();
  });

  it('renders @agentName handle', () => {
    render(<AgentCard agent={baseAgent} />);
    expect(screen.getByText(/@task-clerk/)).toBeInTheDocument();
  });

  it('shows Install button when not installed', () => {
    const onInstall = jest.fn();
    render(<AgentCard agent={baseAgent} onInstall={onInstall} />);
    const btn = screen.getByRole('button', { name: /install/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onInstall).toHaveBeenCalledWith(baseAgent);
  });

  it('shows "Talk to" button when installed and onTalkTo is provided', () => {
    const onTalkTo = jest.fn();
    render(
      <AgentCard
        agent={baseAgent}
        installed
        onTalkTo={onTalkTo}
      />,
    );
    const btn = screen.getByRole('button', { name: /talk to/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onTalkTo).toHaveBeenCalledWith(baseAgent);
  });

  it('Talk to button renders as contained variant (visually prominent)', () => {
    const onTalkTo = jest.fn();
    const { container } = render(
      <AgentCard
        agent={baseAgent}
        installed
        onTalkTo={onTalkTo}
      />,
    );
    const btn = screen.getByRole('button', { name: /talk to/i });
    // MUI contained variant adds MuiButton-contained class
    expect(btn.className).toContain('contained');
  });

  it('shows "Message" button when installed but onTalkTo is NOT provided', () => {
    const onMessage = jest.fn();
    render(
      <AgentCard
        agent={baseAgent}
        installed
        onMessage={onMessage}
      />,
    );
    const btn = screen.getByRole('button', { name: /message/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onMessage).toHaveBeenCalledWith(baseAgent);
  });

  it('renders Configure button for installed agents', () => {
    const onConfigure = jest.fn();
    render(
      <AgentCard
        agent={baseAgent}
        installed
        onConfigure={onConfigure}
        installedActionLabel="Configure"
      />,
    );
    expect(screen.getByRole('button', { name: /configure/i })).toBeInTheDocument();
  });

  it('renders Remove button when canRemove is true', () => {
    const onRemove = jest.fn();
    render(
      <AgentCard
        agent={baseAgent}
        installed
        canRemove
        onRemove={onRemove}
      />,
    );
    const btn = screen.getByRole('button', { name: /remove/i });
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledWith(baseAgent);
  });

  it('renders capability chips', () => {
    render(<AgentCard agent={baseAgent} />);
    expect(screen.getByText('task creation')).toBeInTheDocument();
    expect(screen.getByText('context reading')).toBeInTheDocument();
  });

  it('renders loading skeleton when loading=true', () => {
    const { container } = render(<AgentCard agent={baseAgent} loading />);
    // Skeleton renders MUI Skeleton elements, not the agent content
    expect(screen.queryByText('Task Clerk')).not.toBeInTheDocument();
    expect(container.querySelector('.MuiSkeleton-root')).toBeInTheDocument();
  });

  describe('featured variant', () => {
    it('renders "Talk to" in featured variant when onTalkTo provided', () => {
      const onTalkTo = jest.fn();
      render(
        <AgentCard
          agent={baseAgent}
          variant="featured"
          installed
          onTalkTo={onTalkTo}
        />,
      );
      const btn = screen.getByRole('button', { name: /talk to/i });
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);
      expect(onTalkTo).toHaveBeenCalledWith(baseAgent);
    });

    it('renders "Message" in featured variant when onTalkTo NOT provided', () => {
      const onMessage = jest.fn();
      render(
        <AgentCard
          agent={baseAgent}
          variant="featured"
          installed
          onMessage={onMessage}
        />,
      );
      const btn = screen.getByRole('button', { name: /message/i });
      expect(btn).toBeInTheDocument();
    });
  });

  describe('compact variant', () => {
    it('renders compact card with agent name', () => {
      render(<AgentCard agent={baseAgent} variant="compact" />);
      expect(screen.getByText('Task Clerk')).toBeInTheDocument();
    });
  });
});
