// @ts-nocheck
// Synchronize pods from MongoDB to PostgreSQL
const mongoose = require('mongoose');
const { pool } = require('./config/db-pg');
require('dotenv').config();
const Pod = require('./models/Pod'); // MongoDB model
const PGPod = require('./models/pg/Pod'); // PostgreSQL model

async function syncPods() {
  try {
    // Get MongoDB URI from environment
    const mongoURI = process.env.MONGO_URI;
    if (!mongoURI) {
      throw new Error('MONGO_URI environment variable is not set');
    }

    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB Connected!');

    // Fetch all pods from MongoDB
    console.log('Fetching pods from MongoDB...');
    const mongoPods = await Pod.find();
    console.log(`Found ${mongoPods.length} pods in MongoDB`);

    // For each MongoDB pod, check if it exists in PostgreSQL
    let synced = 0;
    for (const mongoPod of mongoPods) {
      try {
        const mongoPodId = mongoPod._id.toString();
        console.log(`Checking pod: ${mongoPodId} (${mongoPod.name})`);

        // Check if pod exists in PostgreSQL
        const pgPod = await PGPod.findById(mongoPodId);

        if (!pgPod) {
          console.log(`Syncing pod: ${mongoPodId} (${mongoPod.name})`);

          // Insert pod into PostgreSQL with the same ID
          const query = `
            INSERT INTO pods (id, name, description, type, created_by)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO NOTHING
            RETURNING *
          `;

          await pool.query(query, [
            mongoPodId,
            mongoPod.name || 'Unnamed Pod',
            mongoPod.description || '',
            mongoPod.type || 'chat',
            mongoPod.createdBy ? mongoPod.createdBy.toString() : 'unknown',
          ]);

          // Add members to the pod
          if (mongoPod.members && mongoPod.members.length > 0) {
            for (const memberId of mongoPod.members) {
              try {
                await PGPod.addMember(mongoPodId, memberId.toString());
              } catch (memberErr: unknown) {
                console.error(
                  `Error adding member ${memberId} to pod ${mongoPodId}:`,
                  ((memberErr) as Error).message,
                );
              }
            }
          }

          synced++;
        } else {
          console.log(`Pod already exists in PostgreSQL: ${mongoPodId}`);
        }
      } catch (err: unknown) {
        console.error(`Error syncing pod ${mongoPod._id}:`, ((err) as Error).message);
      }
    }

    console.log(`Synchronized ${synced} pods from MongoDB to PostgreSQL`);
  } catch (err: unknown) {
    console.error('Error:', ((err) as Error).message);
  } finally {
    // Close connections
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await pool.end();
  }
}

// Run the sync if executed directly
if (require.main === module) {
  syncPods();
}

module.exports = syncPods;
export {};
