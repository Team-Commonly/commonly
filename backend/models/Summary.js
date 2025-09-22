const mongoose = require('mongoose');

const summarySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['posts', 'chats', 'daily-digest'],
    required: true,
  },
  podId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Pod',
    required: false, // Made optional - individual chat summaries will have podId, overall chat summaries won't
  },
  title: {
    type: String,
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  timeRange: {
    start: { type: Date, required: true },
    end: { type: Date, required: true },
  },
  metadata: {
    totalItems: { type: Number, default: 0 },
    topTags: [{ type: String }],
    topUsers: [{ type: String }],
    podName: { type: String }, // For chat summaries
    userId: { type: String }, // For daily digest summaries
    subscribedPods: { type: Number }, // Number of subscribed pods for daily digest
  },
  // Enhanced analytics data for daily digests
  analytics: {
    // Discussion timeline events
    timeline: [
      {
        timestamp: { type: Date },
        event: { type: String }, // 'peak_activity', 'topic_shift', 'new_participant', 'heated_discussion', etc.
        description: { type: String },
        participants: [{ type: String }],
        intensity: { type: Number, min: 1, max: 10 }, // Event intensity score
      },
    ],

    // Notable quotes from discussions
    quotes: [
      {
        text: { type: String },
        author: { type: String },
        timestamp: { type: Date },
        context: { type: String }, // What was being discussed
        sentiment: {
          type: String,
          enum: ['positive', 'negative', 'neutral', 'humorous', 'insightful'],
        },
        reactions: { type: Number, default: 0 }, // Number of reactions/responses
      },
    ],

    // Key insights and discussion pivots
    insights: [
      {
        type: {
          type: String,
          enum: [
            'trend',
            'sentiment_shift',
            'new_topic',
            'consensus',
            'disagreement',
            'revelation',
          ],
        },
        description: { type: String },
        confidence: { type: Number, min: 0, max: 1 }, // AI confidence in this insight
        impact: { type: String, enum: ['low', 'medium', 'high'] },
        participants: [{ type: String }],
        timestamp: { type: Date },
      },
    ],

    // Discussion atmosphere and mood
    atmosphere: {
      overall_sentiment: {
        type: String,
        enum: [
          'very_positive',
          'positive',
          'neutral',
          'negative',
          'very_negative',
        ],
      },
      energy_level: {
        type: String,
        enum: ['very_low', 'low', 'medium', 'high', 'very_high'],
      },
      engagement_quality: {
        type: String,
        enum: ['superficial', 'moderate', 'deep', 'intense'],
      },
      community_cohesion: { type: Number, min: 0, max: 1 }, // How well the community is working together
      topics_diversity: { type: Number, min: 0, max: 1 }, // Variety of discussion topics
      dominant_emotions: [{ type: String }], // happiness, excitement, concern, curiosity, etc.
    },

    // Participation patterns
    participation: {
      most_active_users: [
        {
          username: { type: String },
          message_count: { type: Number },
          engagement_score: { type: Number }, // Quality of engagement, not just quantity
          role: { type: String }, // moderator, contributor, lurker, newcomer
        },
      ],
      engagement_patterns: {
        peak_hours: [{ type: Number }], // Hours of day with most activity
        discussion_length_avg: { type: Number }, // Average discussion thread length
        response_time_avg: { type: Number }, // Average response time in minutes
      },
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for efficient querying
summarySchema.index({ type: 1, createdAt: -1 });
summarySchema.index({ type: 1, podId: 1, createdAt: -1 });
summarySchema.index({ 'timeRange.start': 1, 'timeRange.end': 1 });
summarySchema.index({ type: 1, 'metadata.userId': 1, createdAt: -1 }); // For daily digest queries

module.exports = mongoose.model('Summary', summarySchema);
