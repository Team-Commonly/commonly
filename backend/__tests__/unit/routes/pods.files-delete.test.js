const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});

const Pod = require('../../../models/Pod');
const File = require('../../../models/File');

jest.mock('../../../models/Pod');
jest.mock('../../../models/File');

const mockObjectStoreDelete = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/objectStore', () => ({
  getObjectStore: () => ({ delete: mockObjectStoreDelete }),
  __resetObjectStoreForTests: jest.fn(),
}));

const routes = require('../../../routes/pods');

const VALID_FILE_ID = '67a9ceb240f8f53015944a05';

describe('pods routes - DELETE /:podId/files/:fileId', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/pods', routes);
    jest.clearAllMocks();
    mockObjectStoreDelete.mockClear();
  });

  it('deletes a file when caller is the pod owner', async () => {
    File.findById.mockResolvedValue({
      _id: VALID_FILE_ID,
      fileName: '1234-5678.pdf',
      podId: { toString: () => 'p1' },
      uploadedBy: { toString: () => 'someone-else' },
    });
    Pod.findById.mockResolvedValue({ createdBy: { toString: () => 'user1' } });
    File.deleteOne = jest.fn().mockResolvedValue(undefined);
    await request(app).delete(`/api/pods/p1/files/${VALID_FILE_ID}`).expect(200);
    expect(File.deleteOne).toHaveBeenCalledWith({ _id: VALID_FILE_ID });
    expect(mockObjectStoreDelete).toHaveBeenCalledWith('1234-5678.pdf');
  });

  it('deletes a file when caller is the original uploader (not owner)', async () => {
    File.findById.mockResolvedValue({
      _id: VALID_FILE_ID,
      fileName: '1234-5678.pdf',
      podId: { toString: () => 'p1' },
      uploadedBy: { toString: () => 'user1' },
    });
    Pod.findById.mockResolvedValue({ createdBy: { toString: () => 'other-owner' } });
    File.deleteOne = jest.fn().mockResolvedValue(undefined);
    await request(app).delete(`/api/pods/p1/files/${VALID_FILE_ID}`).expect(200);
    expect(File.deleteOne).toHaveBeenCalled();
  });

  it('returns 403 when caller is neither owner nor uploader', async () => {
    File.findById.mockResolvedValue({
      _id: VALID_FILE_ID,
      fileName: '1234-5678.pdf',
      podId: { toString: () => 'p1' },
      uploadedBy: { toString: () => 'someone-else' },
    });
    Pod.findById.mockResolvedValue({ createdBy: { toString: () => 'other-owner' } });
    File.deleteOne = jest.fn();
    await request(app).delete(`/api/pods/p1/files/${VALID_FILE_ID}`).expect(403);
    expect(File.deleteOne).not.toHaveBeenCalled();
    expect(mockObjectStoreDelete).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid fileId shape (ReDoS-style abuse)', async () => {
    await request(app).delete('/api/pods/p1/files/not-an-objectid').expect(400);
  });

  it('returns 404 when the file is not found', async () => {
    File.findById.mockResolvedValue(null);
    await request(app).delete(`/api/pods/p1/files/${VALID_FILE_ID}`).expect(404);
  });

  it('returns 404 when the file is in a different pod', async () => {
    File.findById.mockResolvedValue({
      _id: VALID_FILE_ID,
      fileName: '1234-5678.pdf',
      podId: { toString: () => 'OTHER_POD' },
      uploadedBy: { toString: () => 'user1' },
    });
    await request(app).delete(`/api/pods/p1/files/${VALID_FILE_ID}`).expect(404);
  });

  it('completes the metadata delete even when ObjectStore.delete throws', async () => {
    File.findById.mockResolvedValue({
      _id: VALID_FILE_ID,
      fileName: '1234-5678.pdf',
      podId: { toString: () => 'p1' },
      uploadedBy: { toString: () => 'user1' },
    });
    Pod.findById.mockResolvedValue({ createdBy: { toString: () => 'other-owner' } });
    File.deleteOne = jest.fn().mockResolvedValue(undefined);
    mockObjectStoreDelete.mockRejectedValueOnce(new Error('GCS down'));
    await request(app).delete(`/api/pods/p1/files/${VALID_FILE_ID}`).expect(200);
    expect(File.deleteOne).toHaveBeenCalled();
  });
});
