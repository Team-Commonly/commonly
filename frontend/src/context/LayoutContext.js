import React, { createContext, useContext, useState, useEffect } from 'react';

// Create the context
const LayoutContext = createContext();

// Custom hook to use the layout context
export const useLayout = () => {
  return useContext(LayoutContext);
};

// Provider component
export const LayoutProvider = ({ children }) => {
  const [isDashboardCollapsed, setIsDashboardCollapsed] = useState(false);
  
  // Load initial state from localStorage on mount
  useEffect(() => {
    const savedState = localStorage.getItem('dashboardCollapsed');
    const initialState = savedState === 'true';
    setIsDashboardCollapsed(initialState);
    
    // Apply class to body based on initial state
    if (initialState) {
      document.body.classList.add('dashboard-collapsed');
    } else {
      document.body.classList.remove('dashboard-collapsed');
    }
  }, []);
  
  // Toggle dashboard visibility
  const toggleDashboard = () => {
    setIsDashboardCollapsed(prev => {
      const newState = !prev;
      // Save to localStorage
      localStorage.setItem('dashboardCollapsed', newState);
      
      // Apply or remove class to/from body element
      if (newState) {
        document.body.classList.add('dashboard-collapsed');
      } else {
        document.body.classList.remove('dashboard-collapsed');
      }
      
      return newState;
    });
  };
  
  // Value to be provided to consumers
  const value = {
    isDashboardCollapsed,
    toggleDashboard
  };
  
  return (
    <LayoutContext.Provider value={value}>
      {children}
    </LayoutContext.Provider>
  );
}; 