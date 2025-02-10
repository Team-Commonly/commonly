import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';

const VerifyEmail = () => {
  const [message, setMessage] = useState('');
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  useEffect(() => {
    if (token) {
      axios.get(`/api/auth/verify-email?token=${token}`)
        .then((res) => setMessage(res.data.message))
        .catch((err) => setMessage(err.response?.data?.error || "Verification failed."));
    }
  }, [token]);

  return <h3>{message}</h3>;
};

export default VerifyEmail;
