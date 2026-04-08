/**
 * VectorSearchService
 *
 * Provides semantic search over pod knowledge using sqlite-vec.
 * Each pod gets its own isolated SQLite database with vector indices.
 */

/* eslint-disable global-require, import/no-unresolved, no-restricted-syntax, no-await-in-loop, no-plusplus, class-methods-use-this */

import path from 'path';
import fs from 'fs';
import axios from 'axios';

// Lazy-loaded dependencies (may not be installed yet)
let Database: (new (path: string) => DatabaseInstance) | null = null;
let sqliteVec: { load: (db: DatabaseInstance) => void } | null = null;

// Embedding provider configuration
const EMBEDDING_CONFIG = {
  provider: process.env.EMBEDDING_PROVIDER || 'gemini',
  model: process.env.EMBEDDING_MODEL || 'text-embedding-004',
  dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '768', 10),
  chunkSize: 400,
  chunkOverlap: 80,
};

// Data directory for vector databases
const VECTORS_DIR = path.join(__dirname, '..', 'data', 'vectors');

interface PreparedStatement {
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
  run: (...params: unknown[]) => { lastInsertRowid: number };
  get: () => Record<string, unknown>;
}

interface DatabaseInstance {
  exec: (sql: string) => void;
  prepare: (sql: string) => PreparedStatement;
  transaction: (fn: () => Promise<void>) => () => Promise<void>;
  close: () => void;
}

interface TextChunk {
  text: string;
  position: { start: number; end: number };
}

interface SearchResult {
  asset_id: string;
  asset_type: string;
  chunk_text: string;
  metadata: string;
  vectorScore?: number;
  keywordScore?: number;
  combinedScore?: number;
  distance?: number;
  bm25_score?: number;
}

interface SearchOptions {
  limit?: number;
  types?: string[] | null;
  hybrid?: boolean;
  vectorWeight?: number;
  keywordWeight?: number;
  keywordOnly?: boolean;
}

interface IndexResult {
  success: boolean;
  chunksIndexed?: number;
  error?: string;
}

interface StatsResult {
  available: boolean;
  chunks?: number;
  assets?: number;
  embeddings?: number;
}

/**
 * Initialize dependencies
 */
const initDependencies = async (): Promise<boolean> => {
  if (Database && sqliteVec) return true;

  try {
    Database = require('better-sqlite3');
    sqliteVec = require('sqlite-vec');
    return true;
  } catch {
    console.warn('Vector search dependencies not installed. Run: npm install better-sqlite3 sqlite-vec');
    return false;
  }
};

/**
 * Ensure data directory exists
 */
const ensureDataDir = (): void => {
  if (!fs.existsSync(VECTORS_DIR)) {
    fs.mkdirSync(VECTORS_DIR, { recursive: true });
  }
};

/**
 * VectorSearchService class - per-pod instance
 */
class VectorSearchService {
  private podId: string;

  private db: DatabaseInstance | null;

  private initialized: boolean;

  constructor(podId: string) {
    this.podId = podId;
    this.db = null;
    this.initialized = false;
  }

  /**
   * Initialize the database and schema
   */
  async init(): Promise<boolean> {
    if (this.initialized) return true;

    const depsAvailable = await initDependencies();
    if (!depsAvailable) {
      console.warn(`Vector search not available for pod ${this.podId}`);
      return false;
    }

    ensureDataDir();

    const dbPath = path.join(VECTORS_DIR, `${this.podId}.sqlite`);
    this.db = new Database!(dbPath);

    sqliteVec!.load(this.db);

    this.initSchema();
    this.initialized = true;

    return true;
  }

  /**
   * Initialize database schema
   */
  initSchema(): void {
    this.db!.exec(`
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

    this.db!.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${EMBEDDING_CONFIG.dimensions}]
      );
    `);

    this.db!.exec(`
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
  async indexAsset(asset: {
    _id: unknown;
    type?: string;
    title?: string;
    content?: string;
    tags?: string[];
  }): Promise<IndexResult> {
    if (!this.initialized) await this.init();
    if (!this.db) return { success: false, error: 'Database not available' };

    const {
      _id, type, title = '', content = '', tags = [],
    } = asset;
    const assetId = String(_id);

    await this.removeAsset(assetId);

    const chunks = this.chunkText(content, title);

    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (asset_id, asset_type, chunk_index, chunk_text, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertEmbedding = this.db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, embedding)
      VALUES (?, ?)
    `);

    const transaction = this.db.transaction(async () => {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        const result = insertChunk.run(
          assetId,
          type,
          i,
          chunk.text,
          JSON.stringify({ title, tags, position: chunk.position }),
        );

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
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Remove an asset from the index
   */
  async removeAsset(assetId: string): Promise<void> {
    if (!this.db) return;

    const chunks = this.db.prepare('SELECT id FROM chunks WHERE asset_id = ?').all(assetId);
    const deleteEmbedding = this.db.prepare('DELETE FROM chunk_embeddings WHERE chunk_id = ?');
    for (const chunk of chunks) {
      deleteEmbedding.run(chunk.id);
    }

    this.db.prepare('DELETE FROM chunks WHERE asset_id = ?').run(assetId);
  }

  /**
   * Hybrid search: vector + keyword
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.initialized) await this.init();
    if (!this.db) {
      return this.keywordSearchFallback(query, options);
    }

    const {
      limit = 10,
      types = null,
      hybrid = true,
      vectorWeight = 0.7,
      keywordWeight = 0.3,
    } = options;

    const results = new Map<string, SearchResult>();

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

    if (hybrid || options.keywordOnly) {
      const keywordResults = this.keywordSearch(query, limit * 2, types);
      for (const result of keywordResults) {
        if (results.has(result.asset_id)) {
          results.get(result.asset_id)!.keywordScore = result.bm25_score;
        } else {
          results.set(result.asset_id, {
            ...result,
            vectorScore: 0,
            keywordScore: result.bm25_score,
          });
        }
      }
    }

    const combined = Array.from(results.values()).map((r) => ({
      ...r,
      combinedScore: (r.vectorScore || 0) * vectorWeight + (r.keywordScore || 0) * keywordWeight,
    }));

    combined.sort((a, b) => (b.combinedScore || 0) - (a.combinedScore || 0));
    return combined.slice(0, limit);
  }

  /**
   * Vector similarity search
   */
  vectorSearch(queryEmbedding: number[], limit: number, types: string[] | null = null): SearchResult[] {
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

    const params: unknown[] = [new Float32Array(queryEmbedding)];

    if (types && types.length > 0) {
      sql += ` WHERE c.asset_type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ' ORDER BY distance ASC LIMIT ?';
    params.push(limit);

    try {
      return this.db!.prepare(sql).all(...params) as unknown as SearchResult[];
    } catch (error) {
      console.error('Vector search error:', error);
      return [];
    }
  }

  /**
   * Keyword search using FTS5 BM25
   */
  keywordSearch(query: string, limit: number, types: string[] | null = null): SearchResult[] {
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

    const params: unknown[] = [escapedQuery];

    if (types && types.length > 0) {
      sql += ` AND c.asset_type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ' ORDER BY bm25_score LIMIT ?';
    params.push(limit);

    try {
      return this.db!.prepare(sql).all(...params) as unknown as SearchResult[];
    } catch (error) {
      console.error('Keyword search error:', error);
      return [];
    }
  }

  /**
   * Fallback keyword search when vector DB not available
   */
  async keywordSearchFallback(query: string, options: SearchOptions): Promise<SearchResult[]> {
    // eslint-disable-next-line global-require
    const PodAsset = require('../models/PodAsset');

    const filter: Record<string, unknown> = {
      podId: this.podId,
      $text: { $search: query },
    };

    if (options.types) {
      filter.type = { $in: options.types };
    }

    const results = await PodAsset.find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(options.limit || 10)
      .lean() as Array<Record<string, unknown>>;

    return results.map((r) => ({
      asset_id: String(r._id),
      asset_type: r.type as string,
      chunk_text: (r.content as string)?.substring(0, 500),
      metadata: JSON.stringify({ title: r.title, tags: r.tags }),
      combinedScore: r.score as number,
    }));
  }

  /**
   * Chunk text into overlapping segments
   */
  chunkText(text: string, title = ''): TextChunk[] {
    if (!text) return [];

    const words = text.split(/\s+/);
    const chunks: TextChunk[] = [];
    const { chunkSize } = EMBEDDING_CONFIG;
    const overlap = EMBEDDING_CONFIG.chunkOverlap;

    const titlePrefix = title ? `${title}: ` : '';

    for (let i = 0; i < words.length; i += chunkSize - overlap) {
      const chunkWords = words.slice(i, i + chunkSize);
      const isFirst = i === 0;

      chunks.push({
        text: (isFirst ? titlePrefix : '') + chunkWords.join(' '),
        position: { start: i, end: Math.min(i + chunkSize, words.length) },
      });

      if (i + chunkSize >= words.length) break;
    }

    return chunks;
  }

  /**
   * Get embedding for text
   */
  async embed(text: string): Promise<number[] | null> {
    if (!text || text.trim().length === 0) return null;

    try {
      switch (EMBEDDING_CONFIG.provider) {
        case 'gemini':
          return await this.embedWithGemini(text);
        case 'openai':
          return await this.embedWithOpenAI(text);
        case 'litellm':
          return await this.embedWithLiteLLM(text);
        default:
          console.warn(`Unknown embedding provider: ${EMBEDDING_CONFIG.provider}`);
          return null;
      }
    } catch (error) {
      console.error('Embedding error:', error);
      return null;
    }
  }

  async embedWithGemini(text: string): Promise<number[]> {
    // eslint-disable-next-line global-require
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const model = genAI.getGenerativeModel({ model: EMBEDDING_CONFIG.model });
    const result = await model.embedContent(text);

    return result.embedding.values as number[];
  }

  async embedWithOpenAI(text: string): Promise<number[]> {
    // eslint-disable-next-line global-require
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.embeddings.create({
      model: EMBEDDING_CONFIG.model,
      input: text,
    });

    return response.data[0].embedding as number[];
  }

  async embedWithLiteLLM(text: string): Promise<number[]> {
    const baseUrl = process.env.LITELLM_BASE_URL;
    const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY;
    if (!baseUrl || !apiKey) {
      throw new Error('LiteLLM embedding requires LITELLM_BASE_URL + LITELLM_API_KEY');
    }

    const response = await axios.post<{ data: Array<{ embedding: number[] }> }>(
      `${baseUrl.replace(/\/$/, '')}/embeddings`,
      {
        model: EMBEDDING_CONFIG.model,
        input: text,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const embedding = response?.data?.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error('LiteLLM embedding response missing embedding vector');
    }
    return embedding;
  }

  /**
   * Get statistics for this pod's vector index
   */
  getStats(): StatsResult {
    if (!this.db) return { available: false };

    const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get();
    const assetCount = this.db.prepare('SELECT COUNT(DISTINCT asset_id) as count FROM chunks').get();
    const embeddingCount = this.db.prepare('SELECT COUNT(*) as count FROM chunk_embeddings').get();

    return {
      available: true,
      chunks: chunkCount.count as number,
      assets: assetCount.count as number,
      embeddings: embeddingCount.count as number,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

// Cache of VectorSearchService instances per pod
const serviceCache = new Map<string, VectorSearchService>();

const getServiceForPod = async (podId: unknown): Promise<VectorSearchService> => {
  const podIdStr = String(podId);

  if (!serviceCache.has(podIdStr)) {
    const service = new VectorSearchService(podIdStr);
    await service.init();
    serviceCache.set(podIdStr, service);
  }

  return serviceCache.get(podIdStr)!;
};

const indexAsset = async (
  podId: unknown,
  asset: Parameters<VectorSearchService['indexAsset']>[0],
): Promise<IndexResult> => {
  const service = await getServiceForPod(podId);
  return service.indexAsset(asset);
};

const removeAsset = async (podId: unknown, assetId: string): Promise<void> => {
  const service = await getServiceForPod(podId);
  return service.removeAsset(assetId);
};

const search = async (
  podId: unknown,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> => {
  const service = await getServiceForPod(podId);
  return service.search(query, options);
};

const getStats = async (podId: unknown): Promise<StatsResult> => {
  const service = await getServiceForPod(podId);
  return service.getStats();
};

const resetIndex = async (podId: unknown): Promise<{ success: boolean }> => {
  const podIdStr = String(podId);
  const service = serviceCache.get(podIdStr);
  if (service) {
    service.close();
    serviceCache.delete(podIdStr);
  }

  const dbPath = path.join(VECTORS_DIR, `${podIdStr}.sqlite`);
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  return { success: true };
};

const rebuildIndex = async (podId: unknown): Promise<{ indexed: number; errors: number; total: number }> => {
  // eslint-disable-next-line global-require
  const PodAsset = require('../models/PodAsset');
  const service = await getServiceForPod(podId);

  const assets = await PodAsset.find({ podId }).lean() as Array<Record<string, unknown>>;

  let indexed = 0;
  let errors = 0;

  for (const asset of assets) {
    // eslint-disable-next-line no-await-in-loop
    const result = await service.indexAsset(asset as Parameters<VectorSearchService['indexAsset']>[0]);
    if (result.success) {
      indexed++;
    } else {
      errors++;
    }
  }

  return { indexed, errors, total: assets.length };
};

export {
  VectorSearchService,
  getServiceForPod,
  indexAsset,
  removeAsset,
  search,
  getStats,
  resetIndex,
  rebuildIndex,
  EMBEDDING_CONFIG,
};
