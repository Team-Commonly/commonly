import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom'; // ✅ Fix this import
import Login from './components/Login';
import Register from './components/Register';
import VerifyEmail from './components/VerifyEmail';
import PostFeed from './components/PostFeed';
import './App.css';

function App() {
  return (
    <BrowserRouter>  {/* ✅ Ensures proper routing */}
      <div className="App">
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/feed" element={<PostFeed />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
