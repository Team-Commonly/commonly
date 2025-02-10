import React, { useState } from 'react';
import axios from 'axios';

const Register = () => {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');

  const onSubmit = async (e) => {
    e.preventDefault();
    setMessage('');

    try {
      const res = await axios.post(`/api/auth/register`, { username, email, password });
      setMessage(res.data.message);
    } catch (err) {
      setMessage(err.response?.data?.error || "Registration failed.");
    }
  };

  return (
    <form onSubmit={onSubmit}>
      <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required />
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button type="submit">Register</button>
      {message && <p>{message}</p>}
    </form>
  );
};

export default Register;
