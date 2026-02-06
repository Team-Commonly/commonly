import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  TextField,
  CircularProgress,
  Box,
  Typography,
  IconButton,
  Grid,
  Paper,
  ToggleButtonGroup,
  ToggleButton,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import axios from 'axios';

const AvatarGenerator = ({
  open,
  onClose,
  onSelect,
  agentName,
  targetType = 'agent',
}) => {
  const [loading, setLoading] = useState(false);
  const [avatar, setAvatar] = useState(null);
  const [style, setStyle] = useState('realistic');
  const [personality, setPersonality] = useState('friendly');
  const [colorScheme, setColorScheme] = useState('vibrant');
  const [gender, setGender] = useState('neutral');
  const [promptPreset, setPromptPreset] = useState('professional');
  const [customPrompt, setCustomPrompt] = useState('professional profile portrait, natural lighting, clean studio backdrop');
  const [generationInfo, setGenerationInfo] = useState(null);

  const styles = [
    {
      value: 'realistic',
      label: 'Photo Realistic',
      description: 'Natural profile-photo look',
    },
    {
      value: 'anime',
      label: 'Anime Portrait',
      description: 'Stylized character portrait',
    },
    {
      value: 'cartoon',
      label: 'Illustrated',
      description: 'Friendly drawn portrait',
    },
    {
      value: 'game',
      label: 'Game Character',
      description: 'Game-inspired character portrait',
    },
    {
      value: 'minimalist',
      label: 'Minimal Portrait',
      description: 'Simple clean portrait',
    },
  ];

  const personalities = [
    { value: 'friendly', label: 'Friendly', emoji: '😊' },
    { value: 'professional', label: 'Professional', emoji: '💼' },
    { value: 'playful', label: 'Playful', emoji: '🎉' },
    { value: 'wise', label: 'Wise', emoji: '🦉' },
    { value: 'creative', label: 'Creative', emoji: '🎨' },
  ];

  const genders = [
    { value: 'neutral', label: 'Neutral' },
    { value: 'female', label: 'Female' },
    { value: 'male', label: 'Male' },
  ];

  const colorSchemes = [
    {
      value: 'vibrant',
      label: 'Vibrant',
      description: 'Bright, saturated colors',
    },
    {
      value: 'pastel',
      label: 'Pastel',
      description: 'Soft, muted tones',
    },
    {
      value: 'monochrome',
      label: 'Monochrome',
      description: 'Black, white, and grays',
    },
    {
      value: 'neon',
      label: 'Neon',
      description: 'Electric glowing colors',
    },
  ];

  const promptPresets = {
    professional: 'professional profile portrait, natural lighting, clean studio backdrop',
    friendly: 'friendly approachable portrait, soft smile, warm lighting, clean background',
    creator: 'creative modern portrait, expressive but natural look, soft cinematic light',
    executive: 'confident executive portrait, neat attire, premium neutral background',
  };

  const handlePresetChange = (_, value) => {
    if (!value) return;
    setPromptPreset(value);
    setCustomPrompt(promptPresets[value]);
  };

  const generateAvatar = async () => {
    setLoading(true);
    try {
      const response = await axios.post('/api/registry/generate-avatar', {
        agentName,
        style,
        personality,
        colorScheme,
        gender,
        customPrompt,
      });
      setAvatar(response.data.avatar);
      setGenerationInfo(response.data.metadata || null);
    } catch (error) {
      console.error('Failed to generate avatar:', error);
      alert(
        error.response?.data?.error
          || 'Failed to generate avatar. Please try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = () => {
    onSelect(avatar, {
      style,
      personality,
      colorScheme,
      gender,
      customPrompt,
      generationInfo,
    });
    onClose();
  };

  const handleClose = () => {
    setAvatar(null);
    setGenerationInfo(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {targetType === 'user' ? 'Generate Your AI Avatar' : 'Generate Agent AI Avatar'}
      </DialogTitle>
      <DialogContent>
        <Box sx={{ mt: 2 }}>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <ToggleButtonGroup
                exclusive
                fullWidth
                value={promptPreset}
                onChange={handlePresetChange}
                size="small"
              >
                <ToggleButton value="professional">Professional</ToggleButton>
                <ToggleButton value="friendly">Friendly</ToggleButton>
                <ToggleButton value="creator">Creator</ToggleButton>
                <ToggleButton value="executive">Executive</ToggleButton>
              </ToggleButtonGroup>
            </Grid>

            {/* Style Selector */}
            <Grid item xs={12}>
              <FormControl fullWidth>
                <InputLabel>Portrait Style</InputLabel>
                <Select
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                  label="Portrait Style"
                >
                  {styles.map((s) => (
                    <MenuItem key={s.value} value={s.value}>
                      <Box>
                        <Typography variant="body1">{s.label}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {s.description}
                        </Typography>
                      </Box>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            {/* Personality Selector */}
            <Grid item xs={12} sm={6}>
              <FormControl fullWidth>
                <InputLabel>Personality</InputLabel>
                <Select
                  value={personality}
                  onChange={(e) => setPersonality(e.target.value)}
                  label="Personality"
                >
                  {personalities.map((p) => (
                    <MenuItem key={p.value} value={p.value}>
                      {p.emoji} {p.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            {/* Gender Selector */}
            <Grid item xs={12} sm={6}>
              <FormControl fullWidth>
                <InputLabel>Gender</InputLabel>
                <Select
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  label="Gender"
                >
                  {genders.map((g) => (
                    <MenuItem key={g.value} value={g.value}>{g.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            {/* Color Scheme Selector */}
            <Grid item xs={12}>
              <FormControl fullWidth>
                <InputLabel>Color Scheme</InputLabel>
                <Select
                  value={colorScheme}
                  onChange={(e) => setColorScheme(e.target.value)}
                  label="Color Scheme"
                >
                  {colorSchemes.map((c) => (
                    <MenuItem key={c.value} value={c.value}>
                      <Box>
                        <Typography variant="body1">{c.label}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {c.description}
                        </Typography>
                      </Box>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={12}>
              <TextField
                fullWidth
                multiline
                minRows={2}
                maxRows={4}
                label="Prompt Details"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                helperText="Base human-portrait instructions are always applied. Add hairstyle, clothing, mood, background, and vibe."
              />
            </Grid>
          </Grid>

          {/* Avatar Preview */}
          <Paper
            elevation={2}
            sx={{
              mt: 3,
              p: 3,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              border: '2px dashed',
              borderColor: 'divider',
              borderRadius: 2,
              minHeight: 320,
              bgcolor: 'background.default',
            }}
          >
            {loading ? (
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 1,
                }}
              >
                <CircularProgress />
                <Typography sx={{ mt: 2 }} color="text.secondary">
                  Generating your unique avatar...
                </Typography>
              </Box>
            ) : avatar ? (
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: '100%',
                }}
              >
                <Box
                  sx={{
                    width: 200,
                    height: 200,
                    borderRadius: '50%',
                    overflow: 'hidden',
                    boxShadow: 3,
                    mb: 2,
                  }}
                >
                  <img
                    src={avatar}
                    alt="Generated avatar"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                </Box>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Typography variant="body2" color="text.secondary">
                    Love it? Use it! Want a different style?
                  </Typography>
                  <IconButton
                    onClick={generateAvatar}
                    size="small"
                    color="primary"
                    sx={{
                      bgcolor: 'action.hover',
                      '&:hover': { bgcolor: 'action.selected' },
                    }}
                  >
                    <RefreshIcon />
                  </IconButton>
                </Box>
                {generationInfo ? (
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
                    Source: {generationInfo.source || 'unknown'}
                    {generationInfo.model ? ` (${generationInfo.model})` : ''}
                    {generationInfo.fallbackUsed ? ' - fallback mode' : ''}
                  </Typography>
                ) : null}
              </Box>
            ) : (
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 1,
                }}
              >
                <Typography variant="h6" color="text.secondary" gutterBottom>
                  Ready to create?
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Choose a portrait preset and click Generate.
                </Typography>
              </Box>
            )}
          </Paper>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={generateAvatar}
          disabled={loading}
          variant="outlined"
          startIcon={loading ? <CircularProgress size={16} /> : null}
        >
          {avatar ? 'Regenerate' : 'Generate'}
        </Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          disabled={!avatar}
        >
          Use This Avatar
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default AvatarGenerator;
