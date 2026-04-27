const adminDb = db.getSiblingDB('admin');

const appUsername = process.env.MONGO_APP_USERNAME || 'commonly';
const appPassword = process.env.MONGO_APP_PASSWORD || 'commonly_dev';
const appDatabase = process.env.MONGO_APP_DATABASE || 'commonly';

if (!adminDb.getUser(appUsername)) {
  adminDb.createUser({
    user: appUsername,
    pwd: appPassword,
    roles: [
      { role: 'readWrite', db: appDatabase },
    ],
  });
}
