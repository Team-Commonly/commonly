import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';
import { Box, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

const VerifyEmail: React.FC = () => {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  useEffect(() => {
    if (token) {
      axios
        .get<{ message: string }>(`/api/auth/verify-email?token=${token}`)
        .then((res) => setMessage(res.data.message))
        .catch((err: unknown) => {
          const e = err as { response?: { data?: { error?: string } } };
          setMessage(e.response?.data?.error || t('auth.verify.errors.failed'));
        });
    }
  }, [t, token]);

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0b1220',
        px: 2,
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: 520,
          textAlign: 'center',
          p: 4,
          borderRadius: 3,
          border: '1px solid rgba(148, 163, 184, 0.2)',
          backgroundColor: 'rgba(15, 23, 42, 0.8)',
        }}
      >
        <Typography variant="h5" sx={{ color: '#e2e8f0', mb: 2, fontWeight: 700 }}>
          {t('auth.verify.title')}
        </Typography>
        <Typography variant="body1" sx={{ color: '#cbd5e1', mb: 3 }}>
          {message || t('auth.verify.verifying')}
        </Typography>
        {Boolean(message) && (
          <Button component="a" href="/login" variant="contained" sx={{ fontWeight: 600 }}>
            {t('auth.verify.goToLogin')}
          </Button>
        )}
      </Box>
    </Box>
  );
};

export default VerifyEmail;
