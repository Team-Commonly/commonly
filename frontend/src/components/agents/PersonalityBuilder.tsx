import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  TextField,
  Chip,
  Button,
  Paper,
  Grid,
  Stack,
  Divider,
  Alert,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  CircularProgress,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';

interface ToneOption {
  value: string;
  label: string;
  description: string;
  example: string;
}

interface BehaviorOption {
  value: string;
  label: string;
  description: string;
  icon: string;
}

interface ResponseStyleOption {
  value: string;
  label: string;
  description: string;
  icon: string;
}

interface PersonalityConfig {
  tone: string;
  interests: string[];
  behavior: string;
  responseStyle: string;
  specialties: string[];
  boundaries: string[];
  customInstructions: string;
}

interface GeneratedConfig {
  tone?: string;
  specialties?: string[];
  boundaries?: string[];
  customInstructions?: string;
}

interface PersonalityBuilderProps {
  initialConfig?: Partial<PersonalityConfig>;
  onSave: (config: PersonalityConfig) => void;
  agentName?: string;
  onAutoGenerate?: () => Promise<GeneratedConfig | null | undefined>;
  autoGenerating?: boolean;
}

/**
 * Enhanced PersonalityBuilder Component
 *
 * Provides an intuitive UI for configuring agent personality with:
 * - Tone selection with descriptions
 * - Interest tags
 * - Behavior patterns
 * - Response styles
 * - Auto-generation option
 */
const PersonalityBuilder: React.FC<PersonalityBuilderProps> = ({
  initialConfig = {},
  onSave,
  agentName,
  onAutoGenerate,
  autoGenerating = false,
}) => {
  const [config, setConfig] = useState<PersonalityConfig>({
    tone: 'friendly',
    interests: [],
    behavior: 'reactive',
    responseStyle: 'conversational',
    specialties: [],
    boundaries: [],
    customInstructions: '',
    ...initialConfig,
  });

  const [interestInput, setInterestInput] = useState('');
  const [specialtyInput, setSpecialtyInput] = useState('');
  const [boundaryInput, setBoundaryInput] = useState('');

  useEffect(() => {
    setConfig({ ...config, ...initialConfig });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialConfig]);

  const tones: ToneOption[] = [
    {
      value: 'friendly',
      label: 'Friendly 😊',
      description: 'Warm, welcoming, and approachable. Uses casual language and emojis occasionally.',
      example: '"Hey! I\'d love to help you with that. Let me know what you need!"',
    },
    {
      value: 'professional',
      label: 'Professional 💼',
      description: 'Polite, formal, and competent. Provides well-structured, business-appropriate responses.',
      example: '"I would be happy to assist you with this matter. Please provide the relevant details."',
    },
    {
      value: 'sarcastic',
      label: 'Sarcastic 😏',
      description: 'Witty and humorous with a sarcastic edge. Keeps things entertaining while being helpful.',
      example: '"Oh sure, because that\'s definitely going to work... just kidding! Let me show you the right way."',
    },
    {
      value: 'educational',
      label: 'Educational 📚',
      description: 'Knowledgeable teacher style. Explains concepts clearly with examples and context.',
      example: '"Let me break this down for you. Think of it like... Now you try applying that concept."',
    },
    {
      value: 'humorous',
      label: 'Humorous 😂',
      description: 'Funny and entertaining. Makes people laugh while providing helpful information.',
      example: '"Why did the function go to therapy? It had too many issues! But seriously, here\'s the fix..."',
    },
  ];

  const behaviors: BehaviorOption[] = [
    {
      value: 'reactive',
      label: 'Reactive',
      description: 'Only responds when directly mentioned or asked a question. Waits for user input.',
      icon: '⏸️',
    },
    {
      value: 'proactive',
      label: 'Proactive',
      description: 'Actively participates in discussions and shares relevant insights without being asked.',
      icon: '⚡',
    },
    {
      value: 'balanced',
      label: 'Balanced',
      description: 'Responds to mentions and occasionally contributes to relevant discussions.',
      icon: '⚖️',
    },
  ];

  const responseStyles: ResponseStyleOption[] = [
    {
      value: 'concise',
      label: 'Concise',
      description: 'Brief and to the point (1-2 sentences)',
      icon: '📝',
    },
    {
      value: 'detailed',
      label: 'Detailed',
      description: 'Comprehensive, well-explained responses',
      icon: '📖',
    },
    {
      value: 'conversational',
      label: 'Conversational',
      description: 'Natural, friendly conversational style',
      icon: '💬',
    },
  ];

  const addInterest = (): void => {
    if (interestInput && !config.interests.includes(interestInput)) {
      setConfig({
        ...config,
        interests: [...config.interests, interestInput],
      });
      setInterestInput('');
    }
  };

  const removeInterest = (interest: string): void => {
    setConfig({
      ...config,
      interests: config.interests.filter((i) => i !== interest),
    });
  };

  const addSpecialty = (): void => {
    if (specialtyInput && !config.specialties.includes(specialtyInput)) {
      setConfig({
        ...config,
        specialties: [...config.specialties, specialtyInput],
      });
      setSpecialtyInput('');
    }
  };

  const removeSpecialty = (specialty: string): void => {
    setConfig({
      ...config,
      specialties: config.specialties.filter((s) => s !== specialty),
    });
  };

  const addBoundary = (): void => {
    if (boundaryInput && !config.boundaries.includes(boundaryInput)) {
      setConfig({
        ...config,
        boundaries: [...config.boundaries, boundaryInput],
      });
      setBoundaryInput('');
    }
  };

  const removeBoundary = (boundary: string): void => {
    setConfig({
      ...config,
      boundaries: config.boundaries.filter((b) => b !== boundary),
    });
  };

  const handleAutoGenerate = async (): Promise<void> => {
    if (onAutoGenerate) {
      const generated = await onAutoGenerate();
      if (generated) {
        setConfig({
          ...config,
          tone: generated.tone || config.tone,
          specialties: generated.specialties || config.specialties,
          boundaries: generated.boundaries || config.boundaries,
          customInstructions: generated.customInstructions || config.customInstructions,
        });
      }
    }
  };

  const selectedTone = tones.find((t) => t.value === config.tone);

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="h6">Configure Personality</Typography>
        {onAutoGenerate && (
          <Button
            variant="outlined"
            startIcon={autoGenerating ? <CircularProgress size={16} /> : <AutoFixHighIcon />}
            onClick={handleAutoGenerate}
            disabled={autoGenerating || !agentName}
          >
            {autoGenerating ? 'Generating...' : 'Auto-Generate'}
          </Button>
        )}
      </Stack>

      <Grid container spacing={3}>
        {/* Tone Selector */}
        <Grid item xs={12}>
          <Paper elevation={1} sx={{ p: 2 }}>
            <Typography variant="subtitle1" gutterBottom fontWeight="bold">
              Communication Tone
            </Typography>
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>Tone</InputLabel>
              <Select
                value={config.tone}
                onChange={(e) => setConfig({ ...config, tone: e.target.value })}
                label="Tone"
              >
                {tones.map((t) => (
                  <MenuItem key={t.value} value={t.value}>
                    {t.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {selectedTone && (
              <Box>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  {selectedTone.description}
                </Typography>
                <Alert severity="info" sx={{ mt: 1 }}>
                  <Typography variant="caption" fontStyle="italic">
                    Example: {selectedTone.example}
                  </Typography>
                </Alert>
              </Box>
            )}
          </Paper>
        </Grid>

        {/* Behavior & Response Style */}
        <Grid item xs={12} md={6}>
          <Paper elevation={1} sx={{ p: 2 }}>
            <Typography variant="subtitle1" gutterBottom fontWeight="bold">
              Behavior Pattern
            </Typography>
            <FormControl fullWidth>
              <Select
                value={config.behavior}
                onChange={(e) => setConfig({ ...config, behavior: e.target.value })}
              >
                {behaviors.map((b) => (
                  <MenuItem key={b.value} value={b.value}>
                    <Box>
                      <Typography variant="body1">
                        {b.icon} {b.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {b.description}
                      </Typography>
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Paper>
        </Grid>

        <Grid item xs={12} md={6}>
          <Paper elevation={1} sx={{ p: 2 }}>
            <Typography variant="subtitle1" gutterBottom fontWeight="bold">
              Response Style
            </Typography>
            <FormControl fullWidth>
              <Select
                value={config.responseStyle}
                onChange={(e) => setConfig({ ...config, responseStyle: e.target.value })}
              >
                {responseStyles.map((r) => (
                  <MenuItem key={r.value} value={r.value}>
                    <Box>
                      <Typography variant="body1">
                        {r.icon} {r.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {r.description}
                      </Typography>
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Paper>
        </Grid>

        {/* Interests & Topics */}
        <Grid item xs={12}>
          <Paper elevation={1} sx={{ p: 2 }}>
            <Typography variant="subtitle1" gutterBottom fontWeight="bold">
              Interests & Topics
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              Topics this agent cares about and enjoys discussing
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, mb: 1, flexWrap: 'wrap' }}>
              {config.interests.map((interest) => (
                <Chip
                  key={interest}
                  label={interest}
                  onDelete={() => removeInterest(interest)}
                  color="primary"
                  variant="outlined"
                />
              ))}
            </Box>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                fullWidth
                size="small"
                placeholder="Add interest (e.g., AI, Design, Cooking)"
                value={interestInput}
                onChange={(e) => setInterestInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && addInterest()}
              />
              <Button variant="outlined" onClick={addInterest}>
                Add
              </Button>
            </Box>
          </Paper>
        </Grid>

        {/* Advanced Configuration (Accordion) */}
        <Grid item xs={12}>
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="subtitle1" fontWeight="bold">
                Advanced Configuration
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={3}>
                {/* Specialties */}
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Specialties (What the agent excels at)
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                    {config.specialties.map((specialty) => (
                      <Chip
                        key={specialty}
                        label={specialty}
                        onDelete={() => removeSpecialty(specialty)}
                        color="success"
                        size="small"
                      />
                    ))}
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <TextField
                      fullWidth
                      size="small"
                      placeholder="e.g., Code review, Data analysis"
                      value={specialtyInput}
                      onChange={(e) => setSpecialtyInput(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && addSpecialty()}
                    />
                    <Button size="small" variant="outlined" onClick={addSpecialty}>
                      Add
                    </Button>
                  </Box>
                </Box>

                <Divider />

                {/* Boundaries */}
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Boundaries (What the agent won't do)
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                    {config.boundaries.map((boundary) => (
                      <Chip
                        key={boundary}
                        label={boundary}
                        onDelete={() => removeBoundary(boundary)}
                        color="error"
                        size="small"
                        variant="outlined"
                      />
                    ))}
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <TextField
                      fullWidth
                      size="small"
                      placeholder="e.g., Generate harmful content, Share private data"
                      value={boundaryInput}
                      onChange={(e) => setBoundaryInput(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && addBoundary()}
                    />
                    <Button size="small" variant="outlined" onClick={addBoundary}>
                      Add
                    </Button>
                  </Box>
                </Box>

                <Divider />

                {/* Custom Instructions */}
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Custom Instructions
                  </Typography>
                  <TextField
                    fullWidth
                    multiline
                    rows={4}
                    placeholder="Additional personality-specific instructions..."
                    value={config.customInstructions}
                    onChange={(e) =>
                      setConfig({ ...config, customInstructions: e.target.value })
                    }
                    variant="outlined"
                  />
                </Box>
              </Stack>
            </AccordionDetails>
          </Accordion>
        </Grid>
      </Grid>

      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="contained" size="large" onClick={() => onSave(config)}>
          Save Personality Configuration
        </Button>
      </Box>
    </Box>
  );
};

export default PersonalityBuilder;
