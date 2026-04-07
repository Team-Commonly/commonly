import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Typography,
  Paper,
  FormControl,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Chip,
} from '@mui/material';
import * as d3 from 'd3';
import axios from 'axios';

interface KeywordItem {
  word: string;
  frequency: number;
  weight: number;
  sentiment?: string;
  context?: string;
  source?: string;
}

interface KeywordData {
  keywords: KeywordItem[];
  totalSummaries: number;
}

interface WordDatum {
  text: string;
  size: number;
  frequency: number;
  weight: number;
  sentiment?: string;
  context?: string;
  x?: number;
  y?: number;
}

interface KeywordCloudProps {
  timeRange?: string;
}

const KeywordCloud: React.FC<KeywordCloudProps> = ({ timeRange = '24h' }) => {
  const [keywordData, setKeywordData] = useState<KeywordData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewType, setViewType] = useState('cloud');
  const svgRef = useRef<SVGSVGElement>(null);

  const fetchKeywordData = async (): Promise<void> => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');

      const response = await axios.get<KeywordData>(
        `/api/analytics/keywords?timeRange=${timeRange}&maxKeywords=30`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      setKeywordData(response.data);
      setError(null);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || 'Failed to fetch keyword data');
      console.error('Error fetching keyword data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeywordData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange]);

  const renderWordCloud = (): void => {
    if (!keywordData?.keywords || keywordData.keywords.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const width = 500;
    const height = 300;

    svg.attr('width', width).attr('height', height);

    const words: WordDatum[] = keywordData.keywords.map((d) => ({
      text: d.word,
      size: Math.max(12, Math.min(40, d.frequency * 2)),
      frequency: d.frequency,
      weight: d.weight,
      sentiment: d.sentiment,
      context: d.context,
    }));

    // Simple word cloud layout - spiral positioning
    const centerX = width / 2;
    const centerY = height / 2;

    words.forEach((word, i) => {
      const angle = (i / words.length) * 2 * Math.PI;
      const radius = Math.min(width, height) / 4 + i * 5;

      word.x = centerX + Math.cos(angle) * (radius * 0.3);
      word.y = centerY + Math.sin(angle) * (radius * 0.3);
    });

    // Color scale based on frequency
    const colorScale = d3
      .scaleOrdinal<number, string>()
      .domain(words.map((d) => d.frequency))
      .range(['#1da1f2', '#4caf50', '#ff9800', '#9c27b0', '#f44336', '#607d8b']);

    const g = svg.append('g');

    const wordElements = g
      .selectAll<SVGTextElement, WordDatum>('text')
      .data(words)
      .enter()
      .append('text')
      .style('font-size', (d) => `${d.size}px`)
      .style('font-family', 'Arial, sans-serif')
      .style('font-weight', 'bold')
      .style('fill', (d) => colorScale(d.frequency))
      .style('text-anchor', 'middle')
      .style('cursor', 'pointer')
      .attr('x', (d) => d.x ?? 0)
      .attr('y', (d) => d.y ?? 0)
      .text((d) => d.text)
      .on('mouseover', function (event: MouseEvent, d: WordDatum) {
        d3.select(this).style('opacity', 0.7).style('transform', 'scale(1.1)');

        // Show tooltip
        const tooltip = d3
          .select('body')
          .append('div')
          .attr('class', 'tooltip')
          .style('position', 'absolute')
          .style('background', 'rgba(0,0,0,0.8)')
          .style('color', 'white')
          .style('padding', '8px')
          .style('border-radius', '4px')
          .style('font-size', '12px')
          .style('pointer-events', 'none')
          .style('z-index', '1000')
          .html(
            `<strong>${d.text}</strong><br/>Frequency: ${d.frequency}<br/>Weight: ${d.weight.toFixed(3)}${d.sentiment ? `<br/>Sentiment: ${d.sentiment}` : ''}${d.context ? `<br/>Context: ${d.context}` : ''}`,
          );

        tooltip
          .style('left', `${event.pageX + 10}px`)
          .style('top', `${event.pageY - 10}px`);
      })
      .on('mouseout', function () {
        d3.select(this).style('opacity', 1).style('transform', 'scale(1)');

        d3.selectAll('.tooltip').remove();
      });

    // Add animation
    wordElements
      .style('opacity', 0)
      .transition()
      .duration(1000)
      .delay((_d, i) => i * 50)
      .style('opacity', 1);
  };

  useEffect(() => {
    if (viewType === 'cloud' && keywordData?.keywords) {
      renderWordCloud();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordData, viewType]);

  const renderChipView = (): React.ReactNode => {
    if (!keywordData?.keywords) return null;

    const getSentimentColor = (sentiment?: string): string => {
      switch (sentiment) {
        case 'positive': return 'success.main';
        case 'negative': return 'error.main';
        case 'neutral': return 'text.secondary';
        default: return 'primary.main';
      }
    };

    return (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, p: 2 }}>
        {keywordData.keywords.map((keyword, index) => (
          <Chip
            key={keyword.word}
            label={`${keyword.word} (${keyword.frequency})`}
            size="medium"
            variant="outlined"
            sx={{
              fontSize: `${Math.max(0.75, Math.min(1.2, keyword.frequency * 0.05))}rem`,
              color: keyword.sentiment
                ? getSentimentColor(keyword.sentiment)
                : index % 2 === 0
                  ? 'primary.main'
                  : 'secondary.main',
              borderColor: keyword.sentiment
                ? getSentimentColor(keyword.sentiment)
                : index % 2 === 0
                  ? 'primary.main'
                  : 'secondary.main',
            }}
            title={keyword.context || `Frequency: ${keyword.frequency}`}
          />
        ))}
      </Box>
    );
  };

  return (
    <Paper elevation={2} sx={{ p: 3, height: 400 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6" component="h3">
          ☁️ Keyword Analysis
        </Typography>

        <FormControl size="small" sx={{ minWidth: 120 }}>
          <Select
            value={viewType}
            onChange={(e) => setViewType(e.target.value)}
          >
            <MenuItem value="cloud">Word Cloud</MenuItem>
            <MenuItem value="chips">Chip View</MenuItem>
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

      {!loading && !error && keywordData && (
        <Box sx={{ height: 300, overflow: 'hidden' }}>
          {keywordData.keywords.length > 0 ? (
            <>
              {viewType === 'cloud' && (
                <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                  <svg ref={svgRef}></svg>
                </Box>
              )}
              {viewType === 'chips' && renderChipView()}
            </>
          ) : (
            <Box sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '100%',
              color: 'text.secondary',
            }}>
              <Typography>No keywords found for this time period</Typography>
            </Box>
          )}
        </Box>
      )}

      {!loading && !error && keywordData && (
        <Box sx={{ mt: 2, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">
            🔤 {keywordData.keywords.length} keywords
          </Typography>
          <Typography variant="body2" color="text.secondary">
            📄 {keywordData.totalSummaries} summaries analyzed
          </Typography>
          <Typography variant="body2" color="text.secondary">
            ⏰ {timeRange} timeframe
          </Typography>
          {keywordData.keywords.length > 0 && keywordData.keywords[0].source && (
            <Typography variant="body2" color="text.secondary">
              📊 Source: {keywordData.keywords[0].source === 'analytics' ? 'Chat Analytics' : 'Summary Content'}
            </Typography>
          )}
        </Box>
      )}
    </Paper>
  );
};

export default KeywordCloud;
