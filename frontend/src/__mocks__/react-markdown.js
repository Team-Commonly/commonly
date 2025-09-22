import React from 'react';

// Mock ReactMarkdown component for Jest tests
const ReactMarkdown = ({ children }) => {
  return React.createElement('div', { 'data-testid': 'react-markdown' }, children);
};

export default ReactMarkdown;