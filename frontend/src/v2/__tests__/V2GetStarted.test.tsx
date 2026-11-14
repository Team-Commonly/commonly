// D288: the first-run bar. Only the current step acts and records a click;
// a done step is struck and says so; the bar leaves when both are done.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import V2GetStarted from '../components/V2GetStarted';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
const mockTrack = jest.fn();
jest.mock('../utils/usageEvents', () => ({ trackUsage: (...args: unknown[]) => mockTrack(...args) }));

const renderBar = (steps: { connect: boolean; firstTask: boolean }) => {
  const onConnect = jest.fn();
  const onFirstTask = jest.fn();
  const onOpenBoard = jest.fn();
  const view = render(<V2GetStarted steps={steps} podId="pod-1" onConnect={onConnect} onFirstTask={onFirstTask} onOpenBoard={onOpenBoard} />);
  return { onConnect, onFirstTask, onOpenBoard, ...view };
};

beforeEach(() => mockTrack.mockReset());

test('nothing done: step 1 is current and acts, step 2 waits, the count reads 0 of 2', () => {
  const { onConnect, onFirstTask } = renderBar({ connect: false, firstTask: false });
  const connect = screen.getByTestId('get-started-connect');
  const first = screen.getByTestId('get-started-first-task');
  expect(connect).toHaveAttribute('aria-current', 'step');
  expect(first).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByText(/podChat\.getStarted\.count/)).toHaveTextContent('"done":0');

  fireEvent.click(first);
  expect(onFirstTask).not.toHaveBeenCalled();
  expect(mockTrack).not.toHaveBeenCalled();

  fireEvent.click(connect);
  expect(onConnect).toHaveBeenCalledTimes(1);
  expect(mockTrack).toHaveBeenCalledWith('get-started-click', { props: { step: 'connect' }, podId: 'pod-1' });
});

test('step 1 done: it is struck and labelled done, step 2 is current and records its own step', () => {
  const { onConnect, onFirstTask } = renderBar({ connect: true, firstTask: false });
  const connect = screen.getByTestId('get-started-connect');
  expect(connect).toHaveClass('v2-get-started__step--done');
  expect(connect).toHaveAttribute('aria-label', expect.stringContaining('podChat.getStarted.done'));
  fireEvent.click(connect);
  expect(onConnect).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId('get-started-first-task'));
  expect(onFirstTask).toHaveBeenCalledTimes(1);
  expect(mockTrack).toHaveBeenCalledWith('get-started-click', { props: { step: 'first-task' }, podId: 'pod-1' });
});

test('both done: the bar is gone', () => {
  const { container } = renderBar({ connect: true, firstTask: true });
  expect(container).toBeEmptyDOMElement();
});

// The PH walk: step 1 follows the same pick as Scout's filled key.
describe('step 1 follows the person\'s pick', () => {
  const renderPick = (pick: 'hosted' | 'byo' | null, extra: Record<string, unknown> = {}) => {
    const onConnect = jest.fn();
    const onRunHosted = jest.fn();
    render(<V2GetStarted steps={{ connect: false, firstTask: false }} podId="pod-1" onConnect={onConnect} onFirstTask={jest.fn()}
      onOpenBoard={jest.fn()} pick={pick} onRunHosted={onRunHosted} {...extra} />);
    return { onConnect, onRunHosted };
  };

  test('no pick, hosting offered: two equal choices under step 1, each doing what Scout\'s does', () => {
    const { onConnect, onRunHosted } = renderPick(null);
    const group = screen.getByTestId('get-started-choice');
    expect(group).toHaveAttribute('role', 'group');
    const hosted = screen.getByTestId('get-started-run-hosted');
    const own = screen.getByTestId('get-started-connect');
    expect(hosted).toHaveTextContent('podChat.starts.labels.run-hosted');
    expect(own).toHaveTextContent('podChat.getStarted.connectOwn');
    expect(hosted.className).toBe(own.className);
    fireEvent.click(hosted);
    expect(onRunHosted).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenLastCalledWith('get-started-click', { props: { step: 'run-hosted' }, podId: 'pod-1' });
    fireEvent.click(own);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenLastCalledWith('get-started-click', { props: { step: 'connect' }, podId: 'pod-1' });
  });

  test('picked hosted: step 1 is "Run an agent here" and starts it', () => {
    const { onConnect, onRunHosted } = renderPick('hosted');
    expect(screen.queryByTestId('get-started-choice')).not.toBeInTheDocument();
    const step = screen.getByTestId('get-started-connect');
    expect(step).toHaveTextContent('podChat.starts.labels.run-hosted');
    fireEvent.click(step);
    expect(onRunHosted).toHaveBeenCalledTimes(1);
    expect(onConnect).not.toHaveBeenCalled();
  });

  test('picked bring-your-own: step 1 is "Connect your first agent"', () => {
    const { onConnect, onRunHosted } = renderPick('byo');
    const step = screen.getByTestId('get-started-connect');
    expect(step).toHaveTextContent('podChat.getStarted.connect');
    fireEvent.click(step);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onRunHosted).not.toHaveBeenCalled();
  });

  test('no pick where hosting is not offered: the one connect step, as before', () => {
    render(<V2GetStarted steps={{ connect: false, firstTask: false }} podId="pod-1" onConnect={jest.fn()} onFirstTask={jest.fn()} onOpenBoard={jest.fn()} pick={null} />);
    expect(screen.queryByTestId('get-started-choice')).not.toBeInTheDocument();
    expect(screen.getByTestId('get-started-connect')).toHaveTextContent('podChat.getStarted.connect');
  });

  test('after the hosted agent is live (its offer gone), the done step still says "Run an agent here"', () => {
    render(<V2GetStarted steps={{ connect: true, firstTask: false }} podId="pod-1" onConnect={jest.fn()} onFirstTask={jest.fn()}
      onOpenBoard={jest.fn()} pick="hosted" />);
    expect(screen.getByTestId('get-started-connect')).toHaveTextContent('podChat.starts.labels.run-hosted');
  });

  test('while the hosted agent starts, its choice says so and can\'t be pressed twice', () => {
    renderPick(null, { hostedStarting: true });
    const hosted = screen.getByTestId('get-started-run-hosted');
    expect(hosted).toBeDisabled();
    expect(hosted).toHaveTextContent('agentByo.actions.starting');
  });
});
