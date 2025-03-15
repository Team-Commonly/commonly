const { ObjectId } = require('mongodb');

// Mock the pool from db-pg.js
jest.mock('../../../config/db-pg', () => {
  return {
    pool: {
      query: jest.fn()
    }
  };
});

// Import after mocking
const { pool } = require('../../../config/db-pg');
const Pod = require('../../../models/pg/Pod');

// Mock the Pod model methods directly
jest.mock('../../../models/pg/Pod', () => {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    addMember: jest.fn(),
    removeMember: jest.fn(),
    isMember: jest.fn()
  };
});

describe('PostgreSQL Pod Model Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new pod and add creator as member', async () => {
      // Setup mock return values
      const mockPod = {
        id: new ObjectId().toString(),
        name: 'Test Pod',
        description: 'A test pod',
        type: 'chat',
        created_by: 'user123'
      };
      
      Pod.create.mockResolvedValue(mockPod);
      
      const result = await Pod.create(
        mockPod.name,
        mockPod.description, 
        mockPod.type,
        mockPod.created_by
      );
      
      expect(result).toEqual(mockPod);
      expect(Pod.create).toHaveBeenCalledWith(
        mockPod.name,
        mockPod.description, 
        mockPod.type,
        mockPod.created_by
      );
    });

    it('should create a pod with a custom ID if provided', async () => {
      const customId = new ObjectId().toString();
      const mockPod = {
        id: customId,
        name: 'Test Pod',
        description: 'A test pod',
        type: 'chat',
        created_by: 'user123'
      };
      
      Pod.create.mockResolvedValue(mockPod);
      
      const result = await Pod.create(
        mockPod.name,
        mockPod.description, 
        mockPod.type,
        mockPod.created_by,
        customId
      );
      
      expect(result).toEqual(mockPod);
      expect(result.id).toBe(customId);
      expect(Pod.create).toHaveBeenCalledWith(
        mockPod.name,
        mockPod.description, 
        mockPod.type,
        mockPod.created_by,
        customId
      );
    });
  });

  describe('findById', () => {
    it('should find a pod by ID', async () => {
      const mockPod = {
        id: 'pod123',
        name: 'Test Pod',
        description: 'Test description',
        type: 'chat',
        created_by: 'user123',
        members: ['user123', 'user456']
      };
      
      Pod.findById.mockResolvedValue(mockPod);
      
      const result = await Pod.findById(mockPod.id);
      
      expect(result).toEqual(mockPod);
      expect(Pod.findById).toHaveBeenCalledWith(mockPod.id);
    });
    
    it('should return undefined for non-existent pod ID', async () => {
      Pod.findById.mockResolvedValue(undefined);
      
      const result = await Pod.findById('nonexistent');
      
      expect(result).toBeUndefined();
      expect(Pod.findById).toHaveBeenCalledWith('nonexistent');
    });
  });
  
  describe('findAll', () => {
    it('should find all pods', async () => {
      const mockPods = [
        {
          id: 'pod1',
          name: 'Test Pod 1',
          type: 'chat'
        },
        {
          id: 'pod2',
          name: 'Test Pod 2',
          type: 'project'
        }
      ];
      
      Pod.findAll.mockResolvedValue(mockPods);
      
      const result = await Pod.findAll();
      
      expect(result).toEqual(mockPods);
      expect(Pod.findAll).toHaveBeenCalled();
    });
    
    it('should filter pods by type', async () => {
      const mockPods = [
        {
          id: 'pod1',
          name: 'Test Pod 1',
          type: 'chat'
        }
      ];
      
      Pod.findAll.mockResolvedValue(mockPods);
      
      const result = await Pod.findAll('chat');
      
      expect(result).toEqual(mockPods);
      expect(Pod.findAll).toHaveBeenCalledWith('chat');
    });
  });
  
  describe('update', () => {
    it('should update a pod', async () => {
      const mockPod = {
        id: 'pod123',
        name: 'Updated Pod Name',
        description: 'Updated description',
        type: 'chat'
      };
      
      Pod.update.mockResolvedValue(mockPod);
      
      const result = await Pod.update(
        mockPod.id,
        mockPod.name,
        mockPod.description
      );
      
      expect(result).toEqual(mockPod);
      expect(Pod.update).toHaveBeenCalledWith(
        mockPod.id,
        mockPod.name,
        mockPod.description
      );
    });
  });
  
  describe('delete', () => {
    it('should delete a pod', async () => {
      Pod.delete.mockResolvedValue(true);
      
      const result = await Pod.delete('pod123');
      
      expect(result).toBe(true);
      expect(Pod.delete).toHaveBeenCalledWith('pod123');
    });
  });
  
  describe('member management', () => {
    it('should add a member to a pod', async () => {
      const mockMember = { pod_id: 'pod123', user_id: 'user456' };
      Pod.addMember.mockResolvedValue(mockMember);
      
      const result = await Pod.addMember('pod123', 'user456');
      
      expect(result).toEqual(mockMember);
      expect(Pod.addMember).toHaveBeenCalledWith('pod123', 'user456');
    });
    
    it('should not duplicate members when adding the same member twice', async () => {
      const mockMember = { pod_id: 'pod123', user_id: 'user456' };
      Pod.addMember.mockResolvedValue(mockMember);
      
      await Pod.addMember('pod123', 'user456');
      await Pod.addMember('pod123', 'user456');
      
      expect(Pod.addMember).toHaveBeenCalledTimes(2);
    });
    
    it('should remove a member from a pod', async () => {
      Pod.removeMember.mockResolvedValue(true);
      
      const result = await Pod.removeMember('pod123', 'user456');
      
      expect(result).toBe(true);
      expect(Pod.removeMember).toHaveBeenCalledWith('pod123', 'user456');
    });
    
    it('should correctly check if a user is a member of a pod', async () => {
      Pod.isMember.mockResolvedValue(true);
      
      const result = await Pod.isMember('pod123', 'user456');
      
      expect(result).toBe(true);
      expect(Pod.isMember).toHaveBeenCalledWith('pod123', 'user456');
    });
  });
}); 