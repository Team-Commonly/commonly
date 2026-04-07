import React, { createContext, useContext, useState, useEffect } from 'react';

interface LayoutContextValue {
  isDashboardCollapsed: boolean;
  toggleDashboard: () => void;
}

const LayoutContext = createContext<LayoutContextValue | undefined>(undefined);

export const useLayout = (): LayoutContextValue => {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within LayoutProvider');
  return ctx;
};

interface LayoutProviderProps {
  children: React.ReactNode;
}

export const LayoutProvider: React.FC<LayoutProviderProps> = ({ children }) => {
  const [isDashboardCollapsed, setIsDashboardCollapsed] = useState(false);

  useEffect(() => {
    const savedState = localStorage.getItem('dashboardCollapsed');
    let initialState = savedState === 'true';

    if (savedState === null) {
      const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
      if (isMobile) {
        initialState = true;
        localStorage.setItem('dashboardCollapsed', 'true');
      }
    }
    setIsDashboardCollapsed(initialState);

    if (initialState) {
      document.body.classList.add('dashboard-collapsed');
    } else {
      document.body.classList.remove('dashboard-collapsed');
    }
  }, []);

  const toggleDashboard = (): void => {
    setIsDashboardCollapsed((prev) => {
      const newState = !prev;
      localStorage.setItem('dashboardCollapsed', String(newState));
      if (newState) {
        document.body.classList.add('dashboard-collapsed');
      } else {
        document.body.classList.remove('dashboard-collapsed');
      }
      return newState;
    });
  };

  return (
    <LayoutContext.Provider value={{ isDashboardCollapsed, toggleDashboard }}>
      {children}
    </LayoutContext.Provider>
  );
};
