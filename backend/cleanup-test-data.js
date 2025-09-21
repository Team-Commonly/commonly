const connectDB = require('./config/db');
const Pod = require('./models/Pod');
const User = require('./models/User');
const Summary = require('./models/Summary');

async function cleanupTestData() {
  try {
    await connectDB();
    console.log('🧹 Cleaning up corrupted test data...');
    
    // Remove test pods
    const testPods = await Pod.find({ 
      $or: [
        { name: /test/i },
        { name: /digest.*test/i },
        { name: 'Daily Digest Test Pod' }
      ]
    });
    
    console.log('Found test pods:', testPods.map(p => `${p.name} (${p._id})`));
    
    for (const pod of testPods) {
      await Pod.findByIdAndDelete(pod._id);
      console.log('✅ Deleted pod:', pod.name);
    }
    
    // Clean up test users
    const testUsers = await User.find({ 
      username: { $regex: /test|digest.*test/i }
    });
    
    console.log('Found test users:', testUsers.map(u => u.username));
    
    for (const user of testUsers) {
      await User.findByIdAndDelete(user._id);
      console.log('✅ Deleted user:', user.username);
    }
    
    // Clean up test summaries
    const testSummaries = await Summary.find({
      $or: [
        { 'metadata.podName': /test/i },
        { title: /test/i },
        { podId: { $in: testPods.map(p => p._id) } }
      ]
    });
    
    console.log('Found test summaries:', testSummaries.length);
    
    for (const summary of testSummaries) {
      await Summary.findByIdAndDelete(summary._id);
    }
    
    console.log('✅ Deleted', testSummaries.length, 'test summaries');
    console.log('🎉 Cleanup completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Cleanup error:', error);
    process.exit(1);
  }
}

cleanupTestData();