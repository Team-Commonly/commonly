import mongoose, { Document, Schema, Types } from 'mongoose';

export type DiscordSummaryType = 'hourly' | 'daily' | 'manual';

export interface IDiscordSummaryHistory extends Document {
  integrationId: Types.ObjectId;
  summaryType: DiscordSummaryType;
  content: string;
  messageCount: number;
  timeRange: {
    start: Date;
    end: Date;
  };
  postedToDiscord: boolean;
  postedToCommonly: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DiscordSummaryHistorySchema = new Schema<IDiscordSummaryHistory>(
  {
    integrationId: { type: Schema.Types.ObjectId, ref: 'Integration', required: true },
    summaryType: { type: String, required: true, enum: ['hourly', 'daily', 'manual'] },
    content: { type: String, required: true },
    messageCount: { type: Number, required: true },
    timeRange: {
      start: { type: Date, required: true },
      end: { type: Date, required: true },
    },
    postedToDiscord: { type: Boolean, default: false },
    postedToCommonly: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'discord_summary_history' },
);

DiscordSummaryHistorySchema.index({ integrationId: 1, createdAt: -1 });
DiscordSummaryHistorySchema.index({ summaryType: 1 });
DiscordSummaryHistorySchema.index({ timeRange: 1 });

export default mongoose.model<IDiscordSummaryHistory>('DiscordSummaryHistory', DiscordSummaryHistorySchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
