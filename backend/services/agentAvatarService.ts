const axios = require('axios');
const { generateText } = require('./llmService');

const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

/**
 * Agent Avatar Generation Service
 * Uses Gemini AI to generate unique avatar descriptions and creates SVG avatars
 *
 * Note: Gemini 2.5 Flash doesn't currently support direct image generation,
 * so we generate creative SVG avatars based on AI-generated design descriptions.
 */
class AgentAvatarService {
  /**
   * Generate AI avatar for an agent
   */
  static async generateAvatar({
    agentName,
    style = 'realistic',
    personality = 'friendly',
    colorScheme = 'vibrant',
    gender = 'neutral',
    customPrompt = '',
  }: { agentName: any; style?: any; personality?: any; colorScheme?: any; gender?: any; customPrompt?: any }) {
    const result = await this.generateAvatarDetailed({
      agentName,
      style,
      personality,
      colorScheme,
      gender,
      customPrompt,
    });
    return result.avatar;
  }

  /**
   * Generate AI avatar with metadata about which engine produced it.
   */
  static async generateAvatarDetailed({
    agentName,
    style = 'realistic',
    personality = 'friendly',
    colorScheme = 'vibrant',
    gender = 'neutral',
    customPrompt = '',
  }: { agentName: any; style?: any; personality?: any; colorScheme?: any; gender?: any; customPrompt?: any }) {
    try {
      const imageResult = await this.generateImageAvatar({
        agentName,
        style,
        personality,
        colorScheme,
        gender,
        customPrompt,
      });
      if (imageResult?.avatar) {
        return {
          avatar: imageResult.avatar,
          metadata: {
            source: 'gemini-image',
            model: GEMINI_IMAGE_MODEL,
            fallbackUsed: false,
          },
        };
      }
      const avatarDesign = await this.generateAvatarDesign({
        agentName,
        style,
        personality,
        colorScheme,
      });

      // Generate SVG based on design description
      const svg = this.createSVGAvatar(avatarDesign);

      // Return base64 data URI
      const base64Svg = Buffer.from(svg).toString('base64');
      return {
        avatar: `data:image/svg+xml;base64,${base64Svg}`,
        metadata: {
          source: 'svg-fallback',
          model: null,
          fallbackUsed: true,
        },
      };
    } catch (error: any) {
      console.error('Error generating avatar:', error);
      // Fallback to default avatar
      return {
        avatar: this.getFallbackAvatar(agentName),
        metadata: {
          source: 'initial-fallback',
          model: null,
          fallbackUsed: true,
          error: error.message,
        },
      };
    }
  }

  /**
   * Generate image avatar using Gemini image model (fallback to SVG if unavailable).
   */
  static async generateImageAvatar({
    agentName,
    style,
    personality,
    colorScheme,
    gender,
    customPrompt,
  }: { agentName: any; style?: any; personality?: any; colorScheme?: any; gender?: any; customPrompt?: any }) {
    if (!process.env.GEMINI_API_KEY) {
      return null;
    }
    try {
      const prompt = this.createAvatarImagePrompt({
        agentName,
        style,
        personality,
        colorScheme,
        gender,
        customPrompt,
      });
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`,
        {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['Image'],
            imageConfig: { aspectRatio: '1:1' },
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY,
          },
          timeout: 30_000,
        },
      );
      const parts = response.data?.candidates?.[0]?.content?.parts || [];
      const inline = parts.find((part: any) => part?.inlineData || part?.inline_data);
      const inlineData = inline?.inlineData || inline?.inline_data;
      if (!inlineData?.data) {
        return null;
      }
      const mimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
      return {
        avatar: `data:${mimeType};base64,${inlineData.data}`,
      };
    } catch (error: any) {
      console.error('Error generating avatar image:', error.message);
      return null;
    }
  }

  /**
   * Generate avatar design description using AI
   */
  static async generateAvatarDesign({
    agentName, style, personality, colorScheme,
  }: { agentName: any; style?: any; personality?: any; colorScheme?: any }) {
    const prompt = this.createAvatarDesignPrompt({
      agentName,
      style,
      personality,
      colorScheme,
    });

    try {
      const designDescription = await generateText(prompt, {
        temperature: 0.9,
        maxOutputTokens: 500,
      });

      return this.parseDesignDescription(designDescription);
    } catch (error) {
      console.error('Error generating avatar design:', error);
      return this.getDefaultDesign(style, colorScheme);
    }
  }

  /**
   * Create prompt for avatar design generation
   */
  static createAvatarDesignPrompt({
    agentName, style, personality, colorScheme,
  }: { agentName: any; style?: any; personality?: any; colorScheme?: any }) {
    const styleDescriptions = {
      banana: 'a cute, friendly banana character with expressive features',
      abstract: 'abstract geometric shapes with flowing, dynamic forms',
      minimalist: 'minimal, clean design with simple shapes and bold colors',
      cartoon: 'fun, animated character with big expressive eyes',
      geometric: 'geometric patterns with triangles, circles, and polygons',
      anime: 'anime-inspired character portrait with stylized hair and expressive eyes',
      realistic: 'softly shaded, realistic illustration with subtle lighting',
      game: 'video game avatar with bold shapes, playful details, or pixel-art vibes',
    };

    const personalityTraits = {
      friendly: 'warm, welcoming, approachable',
      professional: 'sophisticated, trustworthy, competent',
      playful: 'fun, energetic, whimsical',
      wise: 'knowledgeable, sage-like, calm',
      creative: 'artistic, imaginative, innovative',
    };

    const colorSchemeDescriptions = {
      vibrant: 'bright, saturated colors with high contrast',
      pastel: 'soft, muted pastel tones',
      monochrome: 'shades of gray with black and white accents',
      neon: 'electric, glowing neon colors',
    };

    return `Design a unique avatar for an AI agent named "${agentName}".

Style: ${(styleDescriptions as any)[style] || styleDescriptions.banana}
Personality: ${(personalityTraits as any)[personality] || 'friendly'}
Color Scheme: ${(colorSchemeDescriptions as any)[colorScheme] || 'vibrant'}

Provide a concise design specification in this format:
{
  "mainShape": "circle/square/custom shape description",
  "primaryColor": "hex color",
  "secondaryColor": "hex color",
  "accentColor": "hex color",
  "features": ["feature 1", "feature 2", "feature 3"],
  "emoji": "representative emoji"
}

Keep it suitable for a clean vector avatar (flat shapes, gradients, and simple details).`;
  }

  /**
   * Create prompt for image-based avatar generation
   */
  static createAvatarImagePrompt({
    agentName,
    style,
    personality,
    colorScheme,
    gender = 'neutral',
    customPrompt = '',
  }: { agentName: any; style?: any; personality?: any; colorScheme?: any; gender?: any; customPrompt?: any }) {
    const portraitGender = {
      male: 'male',
      female: 'female',
      neutral: 'androgynous',
    };
    const styleDescriptions = {
      banana: 'playful illustrated portrait',
      abstract: 'stylized portrait with artistic brushwork',
      minimalist: 'clean vector portrait',
      cartoon: 'friendly cartoon portrait',
      geometric: 'stylized portrait with subtle geometric accents',
      anime: 'anime portrait',
      realistic: 'realistic portrait',
      game: 'game character portrait',
    };
    const safeCustomPrompt = String(customPrompt || '').trim().slice(0, 300);

    return [
      `Create a square 1:1 profile avatar for AI agent "${agentName}".`,
      `Render a single ${(portraitGender as any)[gender] || portraitGender.neutral} human person, head-and-shoulders portrait, facing camera.`,
      `Style: ${(styleDescriptions as any)[style] || styleDescriptions.realistic}. Personality: ${personality}. Color scheme: ${colorScheme}.`,
      'Keep face and eyes clearly visible, natural facial features, modern profile-photo composition.',
      'Simple clean background, centered subject, no text, no logo, no watermark, no abstract shapes-only composition.',
      safeCustomPrompt ? `User guidance: ${safeCustomPrompt}` : '',
    ].join(' ');
  }

  /**
   * Parse AI-generated design description
   */
  static parseDesignDescription(description: any) {
    try {
      // Try to extract JSON from response
      const jsonMatch = description.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error('No JSON found in response');
    } catch (error) {
      // Fallback to default design
      return this.getDefaultDesign('banana', 'vibrant');
    }
  }

  /**
   * Get default design based on style
   */
  static getDefaultDesign(style: any, colorScheme: any) {
    const colorSchemes = {
      vibrant: {
        primary: '#FF6B6B',
        secondary: '#4ECDC4',
        accent: '#FFD93D',
      },
      pastel: {
        primary: '#FFB3BA',
        secondary: '#BAE1FF',
        accent: '#FFFFBA',
      },
      monochrome: {
        primary: '#333333',
        secondary: '#888888',
        accent: '#DDDDDD',
      },
      neon: {
        primary: '#FF00FF',
        secondary: '#00FFFF',
        accent: '#FFFF00',
      },
    };

    const colors = (colorSchemes as any)[colorScheme] || colorSchemes.vibrant;

      const designs = {
        banana: {
          mainShape: 'rounded banana shape',
          primaryColor: colors.primary,
          secondaryColor: colors.secondary,
          accentColor: colors.accent,
          features: ['curved body', 'smiling face', 'friendly eyes'],
          emoji: '🍌',
        },
      abstract: {
        mainShape: 'flowing abstract form',
        primaryColor: colors.primary,
        secondaryColor: colors.secondary,
        accentColor: colors.accent,
        features: ['curved lines', 'geometric elements', 'dynamic composition'],
        emoji: '🎨',
      },
      minimalist: {
        mainShape: 'simple circle',
        primaryColor: colors.primary,
        secondaryColor: colors.secondary,
        accentColor: colors.accent,
        features: ['clean lines', 'bold contrast', 'modern aesthetic'],
        emoji: '⚪',
      },
      cartoon: {
        mainShape: 'round character head',
        primaryColor: colors.primary,
        secondaryColor: colors.secondary,
        accentColor: colors.accent,
        features: ['big eyes', 'happy smile', 'expressive face'],
        emoji: '😊',
      },
        geometric: {
          mainShape: 'hexagon',
          primaryColor: colors.primary,
          secondaryColor: colors.secondary,
          accentColor: colors.accent,
          features: ['symmetrical pattern', 'sharp angles', 'mathematical beauty'],
          emoji: '🔷',
        },
        anime: {
          mainShape: 'anime portrait with stylized hair',
          primaryColor: colors.primary,
          secondaryColor: colors.secondary,
          accentColor: colors.accent,
          features: ['large expressive eyes', 'layered hair', 'soft highlights'],
          emoji: '✨',
        },
        realistic: {
          mainShape: 'softly shaded portrait',
          primaryColor: colors.primary,
          secondaryColor: colors.secondary,
          accentColor: colors.accent,
          features: ['subtle gradients', 'gentle lighting', 'balanced proportions'],
          emoji: '🖼️',
        },
        game: {
          mainShape: 'game avatar badge',
          primaryColor: colors.primary,
          secondaryColor: colors.secondary,
          accentColor: colors.accent,
          features: ['pixel accents', 'bold outline', 'emblem shapes'],
          emoji: '🎮',
        },
      };

    return (designs as any)[style] || designs.banana;
  }

  /**
   * Create SVG avatar based on design specification
   */
  static createSVGAvatar(design: any) {
    const { mainShape, primaryColor, secondaryColor, accentColor, emoji } = design;
    const descriptor = `${mainShape} ${(design.features || []).join(' ')} ${emoji}`.toLowerCase();

    // Create style-specific SVG
    if (mainShape.includes('banana') || emoji === '🍌') {
      return this.createBananaSVG(primaryColor, secondaryColor, accentColor);
    }
    if (mainShape.includes('abstract') || emoji === '🎨') {
      return this.createAbstractSVG(primaryColor, secondaryColor, accentColor);
    }
    if (mainShape.includes('geometric') || mainShape.includes('hexagon')) {
      return this.createGeometricSVG(primaryColor, secondaryColor, accentColor);
    }
    if (mainShape.includes('cartoon') || emoji === '😊') {
      return this.createCartoonSVG(primaryColor, secondaryColor, accentColor);
    }
    if (descriptor.includes('anime') || descriptor.includes('chibi') || emoji === '✨') {
      return this.createAnimeSVG(primaryColor, secondaryColor, accentColor);
    }
    if (descriptor.includes('realistic') || descriptor.includes('portrait') || emoji === '🖼️') {
      return this.createRealisticSVG(primaryColor, secondaryColor, accentColor);
    }
    if (descriptor.includes('game') || descriptor.includes('pixel') || emoji === '🎮') {
      return this.createGameSVG(primaryColor, secondaryColor, accentColor);
    }

    // Default: minimalist circle
    return this.createMinimalistSVG(primaryColor, secondaryColor, accentColor);
  }

  /**
   * Create banana-themed SVG
   */
  static createBananaSVG(primary: any, secondary: any, accent: any) {
    return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <rect width="512" height="512" fill="${secondary}"/>
      <!-- Banana body -->
      <path d="M 200 150 Q 150 250 170 350 Q 180 400 250 420 Q 320 400 330 350 Q 350 250 300 150 Z"
            fill="${primary}" stroke="${accent}" stroke-width="8"/>
      <!-- Banana stem -->
      <rect x="235" y="120" width="40" height="40" fill="#8B4513" rx="5"/>
      <!-- Eyes -->
      <circle cx="230" cy="260" r="20" fill="#000000"/>
      <circle cx="270" cy="260" r="20" fill="#000000"/>
      <circle cx="235" cy="255" r="8" fill="#FFFFFF"/>
      <circle cx="275" cy="255" r="8" fill="#FFFFFF"/>
      <!-- Smile -->
      <path d="M 220 310 Q 250 330 280 310"
            stroke="#000000" stroke-width="6" fill="none" stroke-linecap="round"/>
    </svg>`;
  }

  /**
   * Create abstract art SVG
   */
  static createAbstractSVG(primary: any, secondary: any, accent: any) {
    return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${primary};stop-opacity:1" />
          <stop offset="50%" style="stop-color:${secondary};stop-opacity:1" />
          <stop offset="100%" style="stop-color:${accent};stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" fill="#FFFFFF"/>
      <!-- Abstract flowing shapes -->
      <path d="M 0 256 Q 128 100 256 256 T 512 256"
            fill="url(#grad1)" opacity="0.8"/>
      <circle cx="150" cy="150" r="80" fill="${primary}" opacity="0.7"/>
      <circle cx="362" cy="200" r="100" fill="${secondary}" opacity="0.7"/>
      <circle cx="256" cy="350" r="90" fill="${accent}" opacity="0.7"/>
      <path d="M 100 400 Q 256 300 400 420"
            stroke="${primary}" stroke-width="40" fill="none" opacity="0.6"/>
    </svg>`;
  }

  /**
   * Create geometric pattern SVG
   */
  static createGeometricSVG(primary: any, secondary: any, accent: any) {
    return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <rect width="512" height="512" fill="#FFFFFF"/>
      <!-- Hexagon pattern -->
      <polygon points="256,100 356,175 356,325 256,400 156,325 156,175"
               fill="${primary}" stroke="${accent}" stroke-width="8"/>
      <polygon points="256,140 326,187.5 326,287.5 256,335 186,287.5 186,187.5"
               fill="${secondary}" stroke="${primary}" stroke-width="6"/>
      <!-- Inner triangles -->
      <polygon points="256,200 290,240 256,280 222,240"
               fill="${accent}"/>
      <!-- Geometric accents -->
      <circle cx="256" cy="240" r="30" fill="none" stroke="${accent}" stroke-width="4"/>
      <circle cx="256" cy="240" r="15" fill="${primary}"/>
    </svg>`;
  }

  /**
   * Create cartoon character SVG
   */
  static createCartoonSVG(primary: any, secondary: any, accent: any) {
    return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <rect width="512" height="512" fill="${secondary}"/>
      <!-- Head -->
      <circle cx="256" cy="256" r="150" fill="${primary}"/>
      <!-- Eyes -->
      <ellipse cx="210" cy="230" rx="30" ry="40" fill="#FFFFFF"/>
      <ellipse cx="302" cy="230" rx="30" ry="40" fill="#FFFFFF"/>
      <circle cx="215" cy="235" r="18" fill="#000000"/>
      <circle cx="297" cy="235" r="18" fill="#000000"/>
      <circle cx="220" cy="225" r="8" fill="#FFFFFF"/>
      <circle cx="302" cy="225" r="8" fill="#FFFFFF"/>
      <!-- Smile -->
      <path d="M 190 300 Q 256 340 322 300"
            stroke="#000000" stroke-width="10" fill="none" stroke-linecap="round"/>
      <!-- Cheeks -->
      <circle cx="160" cy="280" r="25" fill="${accent}" opacity="0.6"/>
      <circle cx="352" cy="280" r="25" fill="${accent}" opacity="0.6"/>
    </svg>`;
  }

  /**
   * Create anime-inspired SVG
   */
  static createAnimeSVG(primary: any, secondary: any, accent: any) {
    return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="anime-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${secondary}" />
          <stop offset="100%" stop-color="${accent}" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" fill="url(#anime-bg)"/>
      <!-- Hair -->
      <path d="M 120 230 Q 256 80 392 230 Q 360 120 256 140 Q 150 120 120 230 Z" fill="${primary}"/>
      <!-- Face -->
      <ellipse cx="256" cy="290" rx="120" ry="140" fill="#F7E6D0"/>
      <!-- Eyes -->
      <ellipse cx="210" cy="280" rx="32" ry="40" fill="#FFFFFF"/>
      <ellipse cx="302" cy="280" rx="32" ry="40" fill="#FFFFFF"/>
      <circle cx="215" cy="285" r="18" fill="${primary}"/>
      <circle cx="297" cy="285" r="18" fill="${primary}"/>
      <circle cx="225" cy="275" r="6" fill="#FFFFFF"/>
      <circle cx="307" cy="275" r="6" fill="#FFFFFF"/>
      <!-- Mouth -->
      <path d="M 220 350 Q 256 370 292 350" stroke="#333" stroke-width="6" fill="none" stroke-linecap="round"/>
      <!-- Highlight -->
      <circle cx="160" cy="240" r="24" fill="${accent}" opacity="0.6"/>
    </svg>`;
  }

  /**
   * Create realistic-style SVG
   */
  static createRealisticSVG(primary: any, secondary: any, accent: any) {
    return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="realistic-bg" cx="50%" cy="35%" r="70%">
          <stop offset="0%" stop-color="${secondary}"/>
          <stop offset="100%" stop-color="${primary}"/>
        </radialGradient>
        <radialGradient id="realistic-face" cx="40%" cy="35%" r="60%">
          <stop offset="0%" stop-color="#F8E7D1"/>
          <stop offset="100%" stop-color="#E7C9B1"/>
        </radialGradient>
      </defs>
      <rect width="512" height="512" fill="url(#realistic-bg)"/>
      <circle cx="256" cy="280" r="140" fill="url(#realistic-face)"/>
      <path d="M 170 240 Q 256 190 342 240" stroke="${accent}" stroke-width="18" stroke-linecap="round" fill="none" opacity="0.7"/>
      <circle cx="210" cy="285" r="20" fill="#2E2E2E"/>
      <circle cx="302" cy="285" r="20" fill="#2E2E2E"/>
      <circle cx="216" cy="278" r="6" fill="#FFFFFF"/>
      <circle cx="308" cy="278" r="6" fill="#FFFFFF"/>
      <path d="M 210 350 Q 256 380 302 350" stroke="#3A3A3A" stroke-width="8" fill="none" stroke-linecap="round"/>
      <circle cx="170" cy="320" r="18" fill="${accent}" opacity="0.35"/>
      <circle cx="342" cy="320" r="18" fill="${accent}" opacity="0.35"/>
    </svg>`;
  }

  /**
   * Create game-inspired SVG
   */
  static createGameSVG(primary: any, secondary: any, accent: any) {
    return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
      <rect width="512" height="512" fill="${secondary}"/>
      <!-- Pixel badge -->
      <rect x="96" y="96" width="320" height="320" fill="${primary}" stroke="${accent}" stroke-width="12"/>
      <rect x="160" y="160" width="64" height="64" fill="#FFFFFF"/>
      <rect x="288" y="160" width="64" height="64" fill="#FFFFFF"/>
      <rect x="176" y="176" width="32" height="32" fill="#1F1F1F"/>
      <rect x="304" y="176" width="32" height="32" fill="#1F1F1F"/>
      <rect x="208" y="288" width="96" height="32" fill="${accent}"/>
      <rect x="176" y="304" width="160" height="24" fill="${accent}"/>
    </svg>`;
  }

  /**
   * Create minimalist SVG
   */
  static createMinimalistSVG(primary: any, secondary: any, accent: any) {
    return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <rect width="512" height="512" fill="${secondary}"/>
      <!-- Main circle -->
      <circle cx="256" cy="256" r="180" fill="${primary}"/>
      <!-- Accent circle -->
      <circle cx="256" cy="200" r="60" fill="${accent}"/>
      <!-- Simple geometric element -->
      <rect x="206" y="290" width="100" height="20" fill="${accent}" rx="10"/>
    </svg>`;
  }

  /**
   * Fallback avatar using simple initial
   */
  static getFallbackAvatar(agentName: any) {
    const colors = [
      '#FF6B6B',
      '#4ECDC4',
      '#45B7D1',
      '#FFA07A',
      '#98D8C8',
      '#F7DC6F',
      '#BB8FCE',
    ];
    const hash = agentName.split('').reduce((acc: any, char: any) => acc + char.charCodeAt(0), 0);
    const color = colors[hash % colors.length];
    const initial = agentName.charAt(0).toUpperCase();

    return `data:image/svg+xml;base64,${Buffer.from(`
      <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
        <rect width="512" height="512" fill="${color}"/>
        <text x="50%" y="50%" font-size="256" fill="white" text-anchor="middle"
              dy=".35em" font-family="Arial, sans-serif" font-weight="bold">
          ${initial}
        </text>
      </svg>
    `).toString('base64')}`;
  }

  /**
   * Validate generated avatar
   */
  static validateAvatar(imageDataUri: any) {
    try {
      if (!imageDataUri || typeof imageDataUri !== 'string') {
        return { valid: false, error: 'Invalid data URI' };
      }

      if (!imageDataUri.startsWith('data:image/')) {
        return { valid: false, error: 'Not a valid image data URI' };
      }

      const base64Data = imageDataUri.split(',')[1];
      if (!base64Data) {
        return { valid: false, error: 'No base64 data found' };
      }

      const buffer = Buffer.from(base64Data, 'base64');

      return {
        valid: true,
        size: buffer.length,
        format: imageDataUri.includes('svg') ? 'svg' : 'unknown',
      };
    } catch (error: any) {
      return { valid: false, error: error.message };
    }
  }
}

module.exports = AgentAvatarService;

export {};
