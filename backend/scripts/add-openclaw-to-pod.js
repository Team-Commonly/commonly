const mongoose = require('mongoose');
const User = require('../models/User');
const Pod = require('../models/Pod');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ username: 'openclaw-cuz' });
  if (!user) {
    console.log('User not found');
    process.exit(1);
  }

  const podId = '697d1a1bfc1e62c3e4187bf7'; // pod where openclaw is installed
  const pod = await Pod.findById(podId);
  if (!pod) {
    console.log('Pod not found');
    process.exit(1);
  }

  // Add user to pod if not already a member
  // Pod.members is a plain ObjectId array — do not push {userId, role} objects
  const isMember = pod.members?.some(m => m.toString() === user._id.toString());

  if (!isMember) {
    pod.members.push(user._id);
    await pod.save();
    console.log('Added openclaw-cuz to pod:', pod.name);
  } else {
    console.log('User already a member of:', pod.name);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
