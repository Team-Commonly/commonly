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
  const view = render(<V2GetStarted steps={steps} podId="pod-1" onConnect={onConnect} onFirstTask={onFirstTask} />);
  return { onConnect, onFirstTask, ...view };
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
