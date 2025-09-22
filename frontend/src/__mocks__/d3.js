// Mock d3 for Jest tests
export const select = jest.fn(() => ({
  append: jest.fn().mockReturnThis(),
  attr: jest.fn().mockReturnThis(),
  style: jest.fn().mockReturnThis(),
  text: jest.fn().mockReturnThis(),
  selectAll: jest.fn().mockReturnThis(),
  data: jest.fn().mockReturnThis(),
  enter: jest.fn().mockReturnThis(),
  exit: jest.fn().mockReturnThis(),
  remove: jest.fn().mockReturnThis(),
}));

export const scaleLinear = jest.fn(() => ({
  domain: jest.fn().mockReturnThis(),
  range: jest.fn().mockReturnThis(),
}));

export const scaleOrdinal = jest.fn(() => ({
  domain: jest.fn().mockReturnThis(),
  range: jest.fn().mockReturnThis(),
}));

export const schemeCategory10 = ['#1f77b4', '#ff7f0e', '#2ca02c'];

export const forceSimulation = jest.fn(() => ({
  force: jest.fn().mockReturnThis(),
  nodes: jest.fn().mockReturnThis(),
  on: jest.fn().mockReturnThis(),
  stop: jest.fn().mockReturnThis(),
}));

export const forceLink = jest.fn();
export const forceManyBody = jest.fn();
export const forceCenter = jest.fn();

export default {
  select,
  scaleLinear,
  scaleOrdinal,
  schemeCategory10,
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
};