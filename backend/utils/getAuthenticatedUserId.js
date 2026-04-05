const getAuthenticatedUserId = (req) => req.userId || req.user?.id || req.user?._id || null;

module.exports = getAuthenticatedUserId;
