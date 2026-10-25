import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CardContext, TaskView, TraceView } from '../cardViews';
const podId = '111111111111111111111111';
const runId = '012345678901234567890123';
const mockGet = jest.fn();
const mockApi = { get: mockGet };
jest.mock('../../../context/SocketContext', () => ({ useSocket: () => ({ socket:null, connected:false }) }));
jest.mock('../../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
const show = (node: React.ReactNode) => render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}><CardContext.Provider value={{podId,runId}}>{node}</CardContext.Provider></MemoryRouter>);
beforeEach(() => mockGet.mockReset());
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
