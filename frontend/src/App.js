import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Login from './components/Login';
import Register from './components/Register';
import VerifyEmail from './components/VerifyEmail';
import PostFeed from './components/PostFeed';
import Thread from './components/Thread';
import UserProfile from './components/UserProfile';
import Dashboard from './components/Dashboard';
import CreatePost from './components/CreatePost';
import Layout from './components/Layout';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <div className="App">
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/feed" element={<Layout><PostFeed /></Layout>} />
          <Route path="/thread/:id" element={<Layout><Thread /></Layout>} />
          <Route path="/profile" element={<Layout><UserProfile /></Layout>} />
          <Route path="/dashboard" element={<Layout><Dashboard /></Layout>} />
          <Route path="/create-post" element={<Layout><CreatePost /></Layout>} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
