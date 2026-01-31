const User = require('../models/User');
const Pod = require('../models/Pod');

// PostgreSQL connection
let dbPg;
try {
  // eslint-disable-next-line global-require
  dbPg = require('../config/db-pg');
} catch (error) {
  dbPg = null;
}

// PostgreSQL Message model presence indicates PG users table is available
let PGMessage;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (error) {
  PGMessage = null;
}

let PGPod;
try {
  // eslint-disable-next-line global-require
  PGPod = require('../models/pg/Pod');
} catch (error) {
  PGPod = null;
}

const buildAgentEmail = (agentName) => {
  const normalized = agentName.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return `${normalized || 'agent'}@agents.commonly.local`;
};

class AgentIdentityService {
  static async getOrCreateAgentUser(agentName) {
    if (!agentName) {
      throw new Error('agentName is required');
    }

    const username = agentName.toLowerCase();
    let agentUser = await User.findOne({ username });

    if (!agentUser) {
      agentUser = new User({
        username,
        email: buildAgentEmail(username),
        password: `agent-password-${Date.now()}`,
        verified: true,
        profilePicture: 'default',
        role: 'user',
      });

      await agentUser.save();
    }

    return agentUser;
  }

  static async ensureAgentInPod(agentUser, podId) {
    if (!agentUser || !podId) return null;
    const pod = await Pod.findById(podId);
    if (!pod) return null;
    if (!pod.members.includes(agentUser._id)) {
      pod.members.push(agentUser._id);
      await pod.save();
    }
    return pod;
  }

  static async removeAgentFromPod(agentName, podId) {
    if (!agentName || !podId) return null;
    const username = agentName.toLowerCase();
    const agentUser = await User.findOne({ username });
    if (!agentUser) return null;

    const pod = await Pod.findById(podId);
    if (!pod) return null;

    const agentId = agentUser._id.toString();
    const hadMember = pod.members?.some((member) => member.toString() === agentId);
    if (hadMember) {
      pod.members = pod.members.filter((member) => member.toString() !== agentId);
      await pod.save();
    }

    if (process.env.PG_HOST && PGPod) {
      try {
        await PGPod.removeMember(podId, agentId);
      } catch (error) {
        console.warn('Failed to remove agent from PostgreSQL pod members:', error.message);
      }
    }

    return pod;
  }

  static async syncUserToPostgreSQL(user) {
    if (!PGMessage || !process.env.PG_HOST || !dbPg) return;
    try {
      const { pool } = dbPg;
      const checkQuery = 'SELECT _id FROM users WHERE _id = $1';
      const checkResult = await pool.query(checkQuery, [user._id.toString()]);
      if (checkResult.rows.length > 0) return;

      const insertQuery = `
        INSERT INTO users (_id, username, profile_picture, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
      `;

      await pool.query(insertQuery, [
        user._id.toString(),
        user.username,
        user.profilePicture,
        user.createdAt,
        new Date(),
      ]);
    } catch (error) {
      console.error('Failed to sync agent user to PostgreSQL:', error);
    }
  }
}

module.exports = AgentIdentityService;
