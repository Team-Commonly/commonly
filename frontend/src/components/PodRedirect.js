import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const PodRedirect = () => {
  const navigate = useNavigate();
  
  useEffect(() => {
    // Redirect to the chat pods by default
    navigate('/pods/chat');
  }, [navigate]);
  
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <p>Redirecting to pods...</p>
    </div>
  );
};

export default PodRedirect; 