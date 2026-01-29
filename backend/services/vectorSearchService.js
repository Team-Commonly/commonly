/**
 * VectorSearchService
 *
 * Provides semantic search over pod knowledge using sqlite-vec.
 * Each pod gets its own isolated SQLite database with vector indices.
 *
 * Architecture:
 * - Per-pod SQLite databases in data/vectors/<podId>.sqlite
 * - sqlite-vec extension for vector similarity search
 * - Hybrid search: vector similarity + BM25 keyword scoring
 * - Chunking strategy: 400 tokens with 80 token overlap
 */

/* eslint-disable global-require, import/no-unresolved, no-restricted-syntax, no-await-in-loop, no-plusplus, class-methods-use-this */

const path = require('path');
const fs = require('fs');

// Lazy-loaded dependencies (may not be installed yet)
let Database = null;
let sqliteVec = null;

// Embedding provider configuration
const EMBEDDING_CONFIG = {
  provider: process.env.EMBEDDING_PROVIDER || 'gemini', // 'openai', 'gemini', 'local'
  model: process.env.EMBEDDING_MODEL || 'text-embedding-004',
  dimensions: 768, // Gemini embedding dimensions
  chunkSize: 400, // tokens per chunk
  chunkOverlap: 80, // overlap between chunks
};

// Data directory for vector databases
const VECTORS_DIR = path.join(__dirname, '..', 'data', 'vectors');

/**
 * Initialize dependencies
 */
const initDependencies = async () => {
  if (Database && sqliteVec) return true;

  try {
    Database = require('better-sqlite3');
    sqliteVec = require('sqlite-vec');
    return true;
  } catch (error) {
    console.warn('Vector search dependencies not installed. Run: npm install better-sqlite3 sqlite-vec');
    return false;
  }
};

/**
 * Ensure data directory exists
 */
const ensureDataDir = () => {
  if (!fs.existsSync(VECTORS_DIR)) {
    fs.mkdirSync(VECTORS_DIR, { recursive: true });
  }
};

/**
 * VectorSearchService class - per-pod instance
 */
class VectorSearchService {
  constructor(podId) {
    this.podId = podId;
    this.db = null;
    this.initialized = false;
  }

  /**
   * Initialize the database and schema
   */
  async init() {
    if (this.initialized) return true;

    const depsAvailable = await initDependencies();
    if (!depsAvailable) {
      console.warn(`Vector search not available for pod ${this.podId}`);
      return false;
    }

    ensureDataDir();

    const dbPath = path.join(VECTORS_DIR, `${this.podId}.sqlite`);
    this.db = new Database(dbPath);

    // Load sqlite-vec extension
    sqliteVec.load(this.db);

    // Initialize schema
    this.initSchema();
    this.initialized = true;

    return true;
  }

  /**
   * Initialize database schema
   */
  initSchema() {
    // Main chunks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(asset_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_asset_id ON chunks(asset_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_asset_type ON chunks(asset_type);
    `);

    // Vector table using sqlite-vec
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${EMBEDDING_CONFIG.dimensions}]
      );
    `);

    // FTS5 table for keyword search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_text,
        asset_type,
        content='chunks',
        content_rowid='id'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, chunk_text, asset_type)
        VALUES (new.id, new.chunk_text, new.asset_type);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text, asset_type)
        VALUES ('delete', old.id, old.chunk_text, old.asset_type);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text, asset_type)
        VALUES ('delete', old.id, old.chunk_text, old.asset_type);
        INSERT INTO chunks_fts(rowid, chunk_text, asset_type)
        VALUES (new.id, new.chunk_text, new.asset_type);
      END;
    `);
  }

  /**
   * Index an asset (chunk and embed)
   */
  async indexAsset(asset) {
    if (!this.initialized) await this.init();
    if (!this.db) return { success: false, error: 'Database not available' };

    const {
      _id, type, title, content, tags = [],
    } = asset;
    const assetId = _id.toString();

    // Remove existing chunks for this asset
    await this.removeAsset(assetId);

    // Chunk the content
    const chunks = this.chunkText(content, title);

    // Prepare insert statement
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (asset_id, asset_type, chunk_index, chunk_text, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertEmbedding = this.db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, embedding)
      VALUES (?, ?)
    `);

    // Process chunks
    const transaction = this.db.transaction(async () => {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Insert chunk
        const result = insertChunk.run(
          assetId,
          type,
          i,
          chunk.text,
          JSON.stringify({ title, tags, position: chunk.position }),
        );

        // Get embedding
        const embedding = await this.embed(chunk.text);
        if (embedding) {
          insertEmbedding.run(result.lastInsertRowid, new Float32Array(embedding));
        }
      }
    });

    try {
      await transaction();
      return { success: true, chunksIndexed: chunks.length };
    } catch (error) {
      console.error(`Error indexing asset ${assetId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove an asset from the index
   */
  async removeAsset(assetId) {
    if (!this.db) return;

    // Get chunk IDs
    const chunks = this.db.prepare('SELECT id FROM chunks WHERE asset_id = ?').all(assetId);

    // Delete embeddings
    const deleteEmbedding = this.db.prepare('DELETE FROM chunk_embeddings WHERE chunk_id = ?');
    for (const chunk of chunks) {
      deleteEmbedding.run(chunk.id);
    }

    // Delete chunks (FTS will be updated via trigger)
    this.db.prepare('DELETE FROM chunks WHERE asset_id = ?').run(assetId);
  }

  /**
   * Hybrid search: vector + keyword
   */
  async search(query, options = {}) {
    if (!this.initialized) await this.init();
    if (!this.db) {
      // Fallback to keyword-only search if vector DB not available
      return this.keywordSearchFallback(query, options);
    }

    const {
      limit = 10,
      types = null,
      hybrid = true,
      vectorWeight = 0.7,
      keywordWeight = 0.3,
    } = options;

    const results = new Map();

    // Vector search
    if (hybrid || !options.keywordOnly) {
      const queryEmbedding = await this.embed(query);
      if (queryEmbedding) {
        const vectorResults = this.vectorSearch(queryEmbedding, limit * 2, types);
        for (const result of vectorResults) {
          results.set(result.asset_id, {
            ...result,
            vectorScore: result.distance,
            keywordScore: 0,
          });
        }
      }
    }

    // Keyword search (BM25)
    if (hybrid || options.keywordOnly) {
      const keywordResults = this.keywordSearch(query, limit * 2, types);
      for (const result of keywordResults) {
        if (results.has(result.asset_id)) {
          results.get(result.asset_id).keywordScore = result.bm25_score;
        } else {
          results.set(result.asset_id, {
            ...result,
            vectorScore: 0,
            keywordScore: result.bm25_score,
          });
        }
      }
    }

    // Combine scores
    const combined = Array.from(results.values()).map((r) => ({
      ...r,
      combinedScore: r.vectorScore * vectorWeight + r.keywordScore * keywordWeight,
    }));

    // Sort and limit
    combined.sort((a, b) => b.combinedScore - a.combinedScore);

    return combined.slice(0, limit);
  }

  /**
   * Vector similarity search
   */
  vectorSearch(queryEmbedding, limit, types = null) {
    let sql = `
      SELECT
        c.asset_id,
        c.asset_type,
        c.chunk_text,
        c.metadata,
        vec_distance_cosine(e.embedding, ?) as distance
      FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.chunk_id
    `;

    const params = [new Float32Array(queryEmbedding)];

    if (types && types.length > 0) {
      sql += ` WHERE c.asset_type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ' ORDER BY distance ASC LIMIT ?';
    params.push(limit);

    try {
      return this.db.prepare(sql).all(...params);
    } catch (error) {
      console.error('Vector search error:', error);
      return [];
    }
  }

  /**
   * Keyword search using FTS5 BM25
   */
  keywordSearch(query, limit, types = null) {
    // Escape special FTS5 characters
    const escapedQuery = query.replace(/['"]/g, '').trim();

    let sql = `
      SELECT
        c.asset_id,
        c.asset_type,
        c.chunk_text,
        c.metadata,
        bm25(chunks_fts) as bm25_score
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
    `;

    const params = [escapedQuery];

    if (types && types.length > 0) {
      sql += ` AND c.asset_type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ' ORDER BY bm25_score LIMIT ?';
    params.push(limit);

    try {
      return this.db.prepare(sql).all(...params);
    } catch (error) {
      console.error('Keyword search error:', error);
      return [];
    }
  }

  /**
   * Fallback keyword search when vector DB not available
   */
  async keywordSearchFallback(query, options) {
    // Use MongoDB text search as fallback
    const PodAsset = require('../models/PodAsset');

    const filter = {
      podId: this.podId,
      $text: { $search: query },
    };

    if (options.types) {
      filter.type = { $in: options.types };
    }

    const results = await PodAsset.find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(options.limit || 10)
      .lean();

    return results.map((r) => ({
      asset_id: r._id.toString(),
      asset_type: r.type,
      chunk_text: r.content?.substring(0, 500),
      metadata: JSON.stringify({ title: r.title, tags: r.tags }),
      combinedScore: r.score,
    }));
  }

  /**
   * Chunk text into overlapping segments
   */
  chunkText(text, title = '') {
    if (!text) return [];

    const words = text.split(/\s+/);
    const chunks = [];
    const { chunkSize } = EMBEDDING_CONFIG;
    const overlap = EMBEDDING_CONFIG.chunkOverlap;

    // Add title as context to first chunk
    const titlePrefix = title ? `${title}: ` : '';

    for (let i = 0; i < words.length; i += chunkSize - overlap) {
      const chunkWords = words.slice(i, i + chunkSize);
      const isFirst = i === 0;

      chunks.push({
        text: (isFirst ? titlePrefix : '') + chunkWords.join(' '),
        position: { start: i, end: Math.min(i + chunkSize, words.length) },
      });

      // Stop if we've processed all words
      if (i + chunkSize >= words.length) break;
    }

    return chunks;
  }

  /**
   * Get embedding for text
   */
  async embed(text) {
    if (!text || text.trim().length === 0) return null;

    try {
      switch (EMBEDDING_CONFIG.provider) {
        case 'gemini':
          return await this.embedWithGemini(text);
        case 'openai':
          return await this.embedWithOpenAI(text);
        default:
          console.warn(`Unknown embedding provider: ${EMBEDDING_CONFIG.provider}`);
          return null;
      }
    } catch (error) {
      console.error('Embedding error:', error);
      return null;
    }
  }

  /**
   * Embed with Gemini API
   */
  async embedWithGemini(text) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const model = genAI.getGenerativeModel({ model: EMBEDDING_CONFIG.model });
    const result = await model.embedContent(text);

    return result.embedding.values;
  }

  /**
   * Embed with OpenAI API
   */
  async embedWithOpenAI(text) {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.embeddings.create({
      model: EMBEDDING_CONFIG.model,
      input: text,
    });

    return response.data[0].embedding;
  }

  /**
   * Get statistics for this pod's vector index
   */
  getStats() {
    if (!this.db) return { available: false };

    const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get();
    const assetCount = this.db.prepare('SELECT COUNT(DISTINCT asset_id) as count FROM chunks').get();
    const embeddingCount = this.db.prepare('SELECT COUNT(*) as count FROM chunk_embeddings').get();

    return {
      available: true,
      chunks: chunkCount.count,
      assets: assetCount.count,
      embeddings: embeddingCount.count,
    };
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

// Cache of VectorSearchService instances per pod
const serviceCache = new Map();

/**
 * Get or create VectorSearchService for a pod
 */
const getServiceForPod = async (podId) => {
  const podIdStr = podId.toString();

  if (!serviceCache.has(podIdStr)) {
    const service = new VectorSearchService(podIdStr);
    await service.init();
    serviceCache.set(podIdStr, service);
  }

  return serviceCache.get(podIdStr);
};

/**
 * Index a PodAsset
 */
const indexAsset = async (podId, asset) => {
  const service = await getServiceForPod(podId);
  return service.indexAsset(asset);
};

/**
 * Remove a PodAsset from index
 */
const removeAsset = async (podId, assetId) => {
  const service = await getServiceForPod(podId);
  return service.removeAsset(assetId);
};

/**
 * Search pod knowledge base
 */
const search = async (podId, query, options = {}) => {
  const service = await getServiceForPod(podId);
  return service.search(query, options);
};

/**
 * Get index stats for a pod
 */
const getStats = async (podId) => {
  const service = await getServiceForPod(podId);
  return service.getStats();
};

/**
 * Rebuild entire index for a pod
 */
const rebuildIndex = async (podId) => {
  const PodAsset = require('../models/PodAsset');
  const service = await getServiceForPod(podId);

  // Get all assets for this pod
  const assets = await PodAsset.find({ podId }).lean();

  let indexed = 0;
  let errors = 0;

  for (const asset of assets) {
    const result = await service.indexAsset(asset);
    if (result.success) {
      indexed++;
    } else {
      errors++;
    }
  }

  return { indexed, errors, total: assets.length };
};

module.exports = {
  VectorSearchService,
  getServiceForPod,
  indexAsset,
  removeAsset,
  search,
  getStats,
  rebuildIndex,
  EMBEDDING_CONFIG,
};
