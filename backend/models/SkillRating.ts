import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * SkillRating
 *
 * One rating+comment per (skillId, userId). `skillId` is the catalog entry
 * id from `awesome-agent-skills-index.json` (e.g. "artifacts-builder"), not
 * a Mongo ObjectId — the catalog is static/external.
 */

export interface ISkillRating extends Document {
  skillId: string;
  userId: Types.ObjectId;
  rating: number;
  comment?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ISkillRatingAggregate {
  count: number;
  avg: number;
  histogram: Record<1 | 2 | 3 | 4 | 5, number>;
}

export interface ISkillRatingModel extends Model<ISkillRating> {
  getAggregated(skillId: string): Promise<ISkillRatingAggregate>;
  getAggregatedMany(skillIds: string[]): Promise<Map<string, ISkillRatingAggregate>>;
}

const SkillRatingSchema = new Schema<ISkillRating>(
  {
    skillId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: {
        validator: (v: number) => Number.isInteger(v),
        message: 'Rating must be an integer between 1 and 5',
      },
    },
    comment: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },
  },
  { timestamps: true, collection: 'skill_ratings' },
);

// One rating per user per skill — upsert replaces.
SkillRatingSchema.index({ skillId: 1, userId: 1 }, { unique: true });
SkillRatingSchema.index({ skillId: 1, createdAt: -1 });

const emptyHistogram = (): Record<1 | 2 | 3 | 4 | 5, number> => ({
  1: 0, 2: 0, 3: 0, 4: 0, 5: 0,
});

SkillRatingSchema.statics.getAggregated = async function (skillId: string): Promise<ISkillRatingAggregate> {
  const pipeline = [
    { $match: { skillId } },
    {
      $group: {
        _id: '$rating',
        count: { $sum: 1 },
      },
    },
  ];
  const rows = await this.aggregate(pipeline);
  const histogram = emptyHistogram();
  let count = 0;
  let total = 0;
  rows.forEach((row: { _id: number; count: number }) => {
    const bucket = Math.max(1, Math.min(5, Math.round(row._id))) as 1 | 2 | 3 | 4 | 5;
    histogram[bucket] = row.count;
    count += row.count;
    total += bucket * row.count;
  });
  return {
    count,
    avg: count > 0 ? total / count : 0,
    histogram,
  };
};

SkillRatingSchema.statics.getAggregatedMany = async function (skillIds: string[]): Promise<Map<string, ISkillRatingAggregate>> {
  const map = new Map<string, ISkillRatingAggregate>();
  if (!skillIds.length) return map;
  const rows = await this.aggregate([
    { $match: { skillId: { $in: skillIds } } },
    {
      $group: {
        _id: { skillId: '$skillId', rating: '$rating' },
        count: { $sum: 1 },
      },
    },
  ]);
  rows.forEach((row: { _id: { skillId: string; rating: number }; count: number }) => {
    const { skillId, rating } = row._id;
    const bucket = Math.max(1, Math.min(5, Math.round(rating))) as 1 | 2 | 3 | 4 | 5;
    let entry = map.get(skillId);
    if (!entry) {
      entry = { count: 0, avg: 0, histogram: emptyHistogram() };
      map.set(skillId, entry);
    }
    entry.histogram[bucket] = row.count;
    entry.count += row.count;
    entry.avg += bucket * row.count;
  });
  map.forEach((entry) => {
    // Convert the accumulated sum into an average.
    if (entry.count > 0) {
      // eslint-disable-next-line no-param-reassign
      entry.avg /= entry.count;
    }
  });
  return map;
};

export default mongoose.model<ISkillRating, ISkillRatingModel>('SkillRating', SkillRatingSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
