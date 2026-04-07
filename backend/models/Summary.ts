import mongoose, { Document, Schema, Types } from 'mongoose';

export type SummaryType = 'posts' | 'chats' | 'daily-digest';
export type QuoteSentiment = 'positive' | 'negative' | 'neutral' | 'humorous' | 'insightful';
export type InsightType = 'trend' | 'sentiment_shift' | 'new_topic' | 'consensus' | 'disagreement' | 'revelation';
export type InsightImpact = 'low' | 'medium' | 'high';
export type OverallSentiment = 'very_positive' | 'positive' | 'neutral' | 'negative' | 'very_negative';
export type EnergyLevel = 'very_low' | 'low' | 'medium' | 'high' | 'very_high';
export type EngagementQuality = 'superficial' | 'moderate' | 'deep' | 'intense';

export interface ISummary extends Document {
  type: SummaryType;
  podId?: Types.ObjectId;
  title: string;
  content: string;
  timeRange: {
    start: Date;
    end: Date;
  };
  metadata: {
    totalItems?: number;
    topTags?: string[];
    topUsers?: string[];
    podName?: string;
    userId?: string;
    subscribedPods?: number;
    source?: string;
    sources?: string[];
    eventId?: string;
  };
  analytics: {
    timeline: Array<{
      timestamp?: Date;
      event?: string;
      description?: string;
      participants?: string[];
      intensity?: number;
    }>;
    quotes: Array<{
      text?: string;
      author?: string;
      timestamp?: Date;
      context?: string;
      sentiment?: QuoteSentiment;
      reactions?: number;
    }>;
    insights: Array<{
      type?: InsightType;
      description?: string;
      confidence?: number;
      impact?: InsightImpact;
      participants?: string[];
      timestamp?: Date;
    }>;
    atmosphere: {
      overall_sentiment?: OverallSentiment;
      energy_level?: EnergyLevel;
      engagement_quality?: EngagementQuality;
      community_cohesion?: number;
      topics_diversity?: number;
      dominant_emotions?: string[];
    };
    participation: {
      most_active_users: Array<{
        username?: string;
        message_count?: number;
        engagement_score?: number;
        role?: string;
      }>;
      engagement_patterns: {
        peak_hours?: number[];
        discussion_length_avg?: number;
        response_time_avg?: number;
      };
    };
  };
  createdAt: Date;
}

const summarySchema = new Schema<ISummary>({
  type: { type: String, enum: ['posts', 'chats', 'daily-digest'], required: true },
  podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: false },
  title: { type: String, required: true },
  content: { type: String, required: true },
  timeRange: {
    start: { type: Date, required: true },
    end: { type: Date, required: true },
  },
  metadata: {
    totalItems: { type: Number, default: 0 },
    topTags: [{ type: String }],
    topUsers: [{ type: String }],
    podName: { type: String },
    userId: { type: String },
    subscribedPods: { type: Number },
    source: { type: String },
    sources: [{ type: String }],
    eventId: { type: String },
  },
  analytics: {
    timeline: [
      {
        timestamp: { type: Date },
        event: { type: String },
        description: { type: String },
        participants: [{ type: String }],
        intensity: { type: Number, min: 1, max: 10 },
      },
    ],
    quotes: [
      {
        text: { type: String },
        author: { type: String },
        timestamp: { type: Date },
        context: { type: String },
        sentiment: {
          type: String,
          enum: ['positive', 'negative', 'neutral', 'humorous', 'insightful'],
        },
        reactions: { type: Number, default: 0 },
      },
    ],
    insights: [
      {
        type: {
          type: String,
          enum: ['trend', 'sentiment_shift', 'new_topic', 'consensus', 'disagreement', 'revelation'],
        },
        description: { type: String },
        confidence: { type: Number, min: 0, max: 1 },
        impact: { type: String, enum: ['low', 'medium', 'high'] },
        participants: [{ type: String }],
        timestamp: { type: Date },
      },
    ],
    atmosphere: {
      overall_sentiment: {
        type: String,
        enum: ['very_positive', 'positive', 'neutral', 'negative', 'very_negative'],
      },
      energy_level: {
        type: String,
        enum: ['very_low', 'low', 'medium', 'high', 'very_high'],
      },
      engagement_quality: {
        type: String,
        enum: ['superficial', 'moderate', 'deep', 'intense'],
      },
      community_cohesion: { type: Number, min: 0, max: 1 },
      topics_diversity: { type: Number, min: 0, max: 1 },
      dominant_emotions: [{ type: String }],
    },
    participation: {
      most_active_users: [
        {
          username: { type: String },
          message_count: { type: Number },
          engagement_score: { type: Number },
          role: { type: String },
        },
      ],
      engagement_patterns: {
        peak_hours: [{ type: Number }],
        discussion_length_avg: { type: Number },
        response_time_avg: { type: Number },
      },
    },
  },
  createdAt: { type: Date, default: Date.now },
});

summarySchema.index({ type: 1, createdAt: -1 });
summarySchema.index({ type: 1, podId: 1, createdAt: -1 });
summarySchema.index({ 'timeRange.start': 1, 'timeRange.end': 1 });
summarySchema.index({ type: 1, 'metadata.userId': 1, createdAt: -1 });

export default mongoose.model<ISummary>('Summary', summarySchema);
