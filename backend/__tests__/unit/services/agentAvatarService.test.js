const AgentAvatarService = require('../../../services/agentAvatarService');

describe('AgentAvatarService', () => {
  describe('generateAvatar', () => {
    it('should generate banana-themed avatar', async () => {
      const avatar = await AgentAvatarService.generateAvatar({
        agentName: 'test-bot',
        style: 'banana',
        personality: 'friendly',
        colorScheme: 'vibrant',
      });

      expect(avatar).toMatch(/^data:image\//);
    });

    it('should generate abstract avatar', async () => {
      const avatar = await AgentAvatarService.generateAvatar({
        agentName: 'abstract-agent',
        style: 'abstract',
        personality: 'creative',
        colorScheme: 'pastel',
      });

      expect(avatar).toMatch(/^data:image\//);
    });

    it('should generate geometric avatar', async () => {
      const avatar = await AgentAvatarService.generateAvatar({
        agentName: 'geo-bot',
        style: 'geometric',
        personality: 'professional',
        colorScheme: 'monochrome',
      });

      expect(avatar).toMatch(/^data:image\//);
    });

    it('should generate minimalist avatar', async () => {
      const avatar = await AgentAvatarService.generateAvatar({
        agentName: 'minimal-bot',
        style: 'minimalist',
        personality: 'wise',
        colorScheme: 'neon',
      });

      expect(avatar).toMatch(/^data:image\//);
    });

    it('should generate cartoon avatar', async () => {
      const avatar = await AgentAvatarService.generateAvatar({
        agentName: 'cartoon-bot',
        style: 'cartoon',
        personality: 'playful',
        colorScheme: 'vibrant',
      });

      expect(avatar).toMatch(/^data:image\//);
    });

    it('should fallback to simple avatar on error', async () => {
      const avatar = AgentAvatarService.getFallbackAvatar('error-bot');
      expect(avatar).toMatch(/^data:image\/svg\+xml;base64,/);
    });
  });

  describe('validateAvatar', () => {
    it('should validate valid avatar', () => {
      const validAvatar = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48L3N2Zz4=';
      const validation = AgentAvatarService.validateAvatar(validAvatar);

      expect(validation.valid).toBe(true);
      expect(validation.format).toBe('svg');
    });

    it('should reject invalid data URI', () => {
      const invalidAvatar = 'not-a-data-uri';
      const validation = AgentAvatarService.validateAvatar(invalidAvatar);

      expect(validation.valid).toBe(false);
      expect(validation.error).toBeDefined();
    });

    it('should reject null avatar', () => {
      const validation = AgentAvatarService.validateAvatar(null);

      expect(validation.valid).toBe(false);
      expect(validation.error).toBe('Invalid data URI');
    });
  });

  describe('image prompt', () => {
    it('should include portrait constraints and gender', () => {
      const prompt = AgentAvatarService.createAvatarImagePrompt({
        agentName: 'portrait-bot',
        style: 'realistic',
        personality: 'friendly',
        colorScheme: 'vibrant',
        gender: 'female',
        customPrompt: 'short curly hair and blazer',
      });

      expect(prompt).toContain('head-and-shoulders portrait');
      expect(prompt).toContain('female');
      expect(prompt).toContain('short curly hair and blazer');
      expect(prompt).toContain('no abstract shapes-only composition');
    });
  });

  describe('getDefaultDesign', () => {
    it('should return banana design for banana style', () => {
      const design = AgentAvatarService.getDefaultDesign('banana', 'vibrant');

      expect(design.emoji).toBe('🍌');
      expect(design.mainShape).toContain('banana');
      expect(design.features).toBeInstanceOf(Array);
    });

    it('should return abstract design for abstract style', () => {
      const design = AgentAvatarService.getDefaultDesign('abstract', 'pastel');

      expect(design.emoji).toBe('🎨');
      expect(design.features).toContain('curved lines');
    });

    it('should return geometric design for geometric style', () => {
      const design = AgentAvatarService.getDefaultDesign('geometric', 'monochrome');

      expect(design.emoji).toBe('🔷');
      expect(design.mainShape).toBe('hexagon');
    });
  });

  describe('SVG generation', () => {
    it('should create banana SVG', () => {
      const svg = AgentAvatarService.createBananaSVG('#FF6B6B', '#4ECDC4', '#FFD93D');

      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg.toLowerCase()).toContain('banana');
    });

    it('should create abstract SVG', () => {
      const svg = AgentAvatarService.createAbstractSVG('#FF6B6B', '#4ECDC4', '#FFD93D');

      expect(svg).toContain('<svg');
      expect(svg).toContain('linearGradient');
    });

    it('should create geometric SVG', () => {
      const svg = AgentAvatarService.createGeometricSVG('#FF6B6B', '#4ECDC4', '#FFD93D');

      expect(svg).toContain('<svg');
      expect(svg).toContain('polygon');
    });

    it('should create cartoon SVG', () => {
      const svg = AgentAvatarService.createCartoonSVG('#FF6B6B', '#4ECDC4', '#FFD93D');

      expect(svg).toContain('<svg');
      expect(svg).toContain('circle'); // For head and eyes
    });

    it('should create minimalist SVG', () => {
      const svg = AgentAvatarService.createMinimalistSVG('#FF6B6B', '#4ECDC4', '#FFD93D');

      expect(svg).toContain('<svg');
      expect(svg).toContain('circle');
    });
  });
});
