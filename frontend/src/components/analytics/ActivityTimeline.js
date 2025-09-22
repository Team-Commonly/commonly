import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Paper,
  FormControl,
  Select,
  MenuItem,
  CircularProgress,
  Alert
} from '@mui/material';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import axios from 'axios';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend
);

const ActivityTimeline = ({ timeRange = '24h' }) => {
  const [activityData, setActivityData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chartType, setChartType] = useState('hourly');

  const fetchActivityData = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      
      const response = await axios.get(`/api/analytics/activity?timeRange=${timeRange}&type=${chartType}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setActivityData(response.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch activity data');
      console.error('Error fetching activity data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchActivityData();
  }, [timeRange, chartType]);

  const formatChartData = () => {
    if (!activityData?.activity) return null;

    const { activity } = activityData;

    if (chartType === 'hourly') {
      // Create 24-hour format
      const hourlyData = Array.from({ length: 24 }, (_, hour) => {
        const found = activity.find(a => a.hour === hour);
        return found ? found.activity : 0;
      });

      return {
        labels: Array.from({ length: 24 }, (_, i) => 
          `${i.toString().padStart(2, '0')}:00`
        ),
        datasets: [
          {
            label: 'Activity Level',
            data: hourlyData,
            borderColor: 'rgb(29, 161, 242)',
            backgroundColor: 'rgba(29, 161, 242, 0.1)',
            tension: 0.4,
            fill: true
          }
        ]
      };
    }

    if (chartType === 'daily') {
      return {
        labels: activity.map(a => new Date(a.day).toLocaleDateString()),
        datasets: [
          {
            label: 'Daily Activity',
            data: activity.map(a => a.activity),
            backgroundColor: 'rgba(29, 161, 242, 0.6)',
            borderColor: 'rgb(29, 161, 242)',
            borderWidth: 1
          }
        ]
      };
    }

    if (chartType === 'sentiment') {
      const sentimentColors = {
        'very_positive': '#4caf50',
        'positive': '#8bc34a',
        'neutral': '#ffc107',
        'negative': '#ff9800',
        'very_negative': '#f44336'
      };

      return {
        labels: activity.map(a => new Date(a.timestamp).toLocaleTimeString()),
        datasets: [
          {
            label: 'Sentiment Over Time',
            data: activity.map(a => a.activity),
            backgroundColor: activity.map(a => sentimentColors[a.sentiment] || '#9e9e9e'),
            borderColor: 'rgba(0,0,0,0.1)',
            borderWidth: 1
          }
        ]
      };
    }

    return null;
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top',
      },
      title: {
        display: true,
        text: `${chartType.charAt(0).toUpperCase() + chartType.slice(1)} Activity Pattern`
      },
    },
    scales: {
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: chartType === 'sentiment' ? 'Activity Level' : 'Messages'
        }
      },
      x: {
        title: {
          display: true,
          text: chartType === 'hourly' ? 'Hour of Day' : 
                chartType === 'daily' ? 'Date' : 'Time'
        },
        ticks: {
          maxRotation: 45,
          minRotation: 45,
          maxTicksLimit: chartType === 'hourly' ? 12 : 10
        }
      }
    }
  };

  const chartData = formatChartData();

  return (
    <Paper elevation={2} sx={{ p: 3, height: 400 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6" component="h3">
          📈 Activity Timeline
        </Typography>
        
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <Select
            value={chartType}
            onChange={(e) => setChartType(e.target.value)}
          >
            <MenuItem value="hourly">Hourly</MenuItem>
            <MenuItem value="daily">Daily</MenuItem>
            <MenuItem value="sentiment">Sentiment</MenuItem>
          </Select>
        </FormControl>
      </Box>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 300 }}>
          <CircularProgress />
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {!loading && !error && activityData && (
        <Box sx={{ height: 300 }}>
          {chartData && activityData.activity.length > 0 ? (
            chartType === 'daily' || chartType === 'sentiment' ? (
              <Bar data={chartData} options={chartOptions} />
            ) : (
              <Line data={chartData} options={chartOptions} />
            )
          ) : (
            <Box sx={{ 
              display: 'flex', 
              justifyContent: 'center', 
              alignItems: 'center', 
              height: '100%',
              color: 'text.secondary'
            }}>
              <Typography>No activity data available for this time period</Typography>
            </Box>
          )}
        </Box>
      )}

      {!loading && !error && activityData && (
        <Box sx={{ mt: 2, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">
            📊 {activityData.totalDataPoints} data points
          </Typography>
          <Typography variant="body2" color="text.secondary">
            ⏰ {timeRange} timeframe
          </Typography>
          <Typography variant="body2" color="text.secondary">
            📈 {chartType} view
          </Typography>
        </Box>
      )}
    </Paper>
  );
};

export default ActivityTimeline;