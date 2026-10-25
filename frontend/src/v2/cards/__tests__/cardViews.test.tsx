import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CardContext, TaskView, TraceView } from '../cardViews';
const podId = '111111111111111111111111';
const runId = '012345678901234567890123';
const mockGet = jest.fn();
const mockApi = { get: mockGet };
const mockSocket = { on: jest.fn(), off: jest.fn() };
jest.mock('../../../context/SocketContext', () => ({ useSocket: () => ({ socket:mockSocket, connected:true }) }));
jest.mock('../../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
const show = (node: React.ReactNode) => render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}><CardContext.Provider value={{podId,runId}}>{node}</CardContext.Provider></MemoryRouter>);
beforeEach(() => { mockGet.mockReset(); mockSocket.on.mockReset(); mockSocket.off.mockReset(); });
test('TaskStatus reads the current pod board instead of author-provided state', async () => {
  mockGet.mockResolvedValue({ tasks: [{taskId:'TASK-498', title:'Board truth', status:'claimed'}] });
  show(<TaskView taskId="TASK-498" note="Agent annotation" />);
  expect(await screen.findByText('Board truth')).toBeInTheDocument();
  expect(mockGet).toHaveBeenCalledWith(`/api/v1/tasks/${podId}`);
  expect(screen.getByText('claimed · Agent annotation')).toBeInTheDocument();
});
test('RunTrace limits metadata rows and never renders args or results', async () => {
  mockGet.mockResolvedValue({run:{id:runId,podId,startedAt:'2026-10-25T00:00:00Z',completedAt:'2026-10-25T00:02:10Z',omittedToolCalls:0,turns:[{toolCalls:[{name:'older',outcome:'ok',elapsedMs:50},{name:'newest',outcome:'refused',elapsedMs:20,args:{secret:'DO-NOT-RENDER'},result:'DO-NOT-RENDER'}]}]}});
  show(<TraceView limit={1} />);
  expect(await screen.findByText('newest')).toBeInTheDocument();
  expect(screen.queryByText('older')).not.toBeInTheDocument();
  expect(screen.queryByText('DO-NOT-RENDER')).not.toBeInTheDocument();
  expect(screen.getByText('run · 2 calls · 2m 10s')).toBeInTheDocument();
  expect(mockGet).toHaveBeenCalledWith(`/api/pods/${podId}/runs/${runId}`);
});
test('a mismatched trace receipt cannot fill this card', async () => {
  mockGet.mockResolvedValue({run:{id:'other',podId,turns:[]}});
  show(<TraceView limit={3} />);
  expect(await screen.findByText('Trace unavailable')).toBeInTheDocument();
});

test('task_updated refreshes board truth and unsubscribes on unmount', async () => {
  mockGet.mockResolvedValueOnce({ tasks: [{ taskId:'TASK-498',title:'Old board',status:'claimed' }] })
    .mockResolvedValueOnce({ tasks: [{ taskId:'TASK-498',title:'New board',status:'done' }] });
  const view = show(<TaskView taskId="TASK-498" />);
  expect(await screen.findByText('Old board')).toBeInTheDocument();
  const update = mockSocket.on.mock.calls.find(([name]) => name === 'task_updated')[1];
  await act(async () => update({ podId }));
  expect(await screen.findByText('New board')).toBeInTheDocument();
  expect(mockGet).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(mockSocket.off).toHaveBeenCalledWith('task_updated', update);
});

test('forwarded traces use the original pod while TaskStatus uses the displayed board', async () => {
  const runPodId = '222222222222222222222222';
  mockGet.mockImplementation((path: string) => Promise.resolve(path.includes('/runs/')
    ? { run: { id:runId,podId:runPodId,turns:[{toolCalls:[{name:'source pod call',outcome:'ok',elapsedMs:1}]}] } }
    : { tasks:[{taskId:'TASK-498',title:'Displayed pod task',status:'done'}] }));
  render(<MemoryRouter><CardContext.Provider value={{podId,runPodId,runId}}>
    <TaskView taskId="TASK-498" /><TraceView limit={1} />
  </CardContext.Provider></MemoryRouter>);
  expect(await screen.findByText('source pod call')).toBeInTheDocument();
  expect(await screen.findByText('Displayed pod task')).toBeInTheDocument();
  expect(mockGet).toHaveBeenCalledWith(`/api/pods/${runPodId}/runs/${runId}`);
  expect(mockGet).toHaveBeenCalledWith(`/api/v1/tasks/${podId}`);
  expect(screen.getByRole('link',{name:'Open trace'})).toHaveAttribute('href', `/v2/pods/${runPodId}/runs/${runId}`);
});
