import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Grid,
  Stack,
  Typography,
} from '@mui/material';
import ExtensionIcon from '@mui/icons-material/Extension';
import { useAuth } from '../context/AuthContext';

const capabilityLabels = {
  webhook: 'Webhook',
  gateway: 'Gateway',
  summary: 'Summary',
  commands: 'Commands',
};

const IntegrationsCatalog = () => {
  const { token } = useAuth();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchCatalog = async () => {
      if (!token) {
        setEntries([]);
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const res = await axios.get('/api/integrations/catalog', {
          headers: { Authorization: `Bearer ${token}` },
        });
        setEntries(res.data?.entries || []);
        setError(null);
      } catch (err) {
        console.error('Error fetching integrations catalog:', err);
        setError('Failed to load integrations catalog.');
      } finally {
        setLoading(false);
      }
    };

    fetchCatalog();
  }, [token]);

  const sortedEntries = useMemo(() => (
    [...entries].sort((a, b) => {
      const aLabel = a.catalog?.label || a.id;
      const bLabel = b.catalog?.label || b.id;
      return aLabel.localeCompare(bLabel);
    })
  ), [entries]);

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
        <ExtensionIcon color="primary" />
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          Integrations Catalog
        </Typography>
      </Stack>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Integrations are manifest-driven providers. They feed pod context and summaries.
      </Typography>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}

      {!loading && error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {!loading && !error && (
        <Grid container spacing={2}>
          {sortedEntries.map((entry) => {
            const label = entry.catalog?.label || entry.id;
            const description = entry.catalog?.description || 'No description provided.';
            const capabilities = entry.catalog?.capabilities || [];
            const activeCount = entry.stats?.activeIntegrations || 0;

            return (
              <Grid item xs={12} sm={6} md={4} key={entry.id}>
                <Card variant="outlined" sx={{ height: '100%' }}>
                  <CardContent>
                    <Stack spacing={1.5}>
                      <Box>
                        <Typography variant="h6" sx={{ fontWeight: 700 }}>
                          {label}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {description}
                        </Typography>
                      </Box>

                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Active Integrations
                        </Typography>
                        <Typography variant="h5" sx={{ fontWeight: 800 }}>
                          {activeCount}
                        </Typography>
                      </Box>

                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        {capabilities.map((capability) => (
                          <Chip
                            key={`${entry.id}-${capability}`}
                            size="small"
                            label={capabilityLabels[capability] || capability}
                          />
                        ))}
                      </Stack>
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            );
          })}
        </Grid>
      )}
    </Container>
  );
};

export default IntegrationsCatalog;

