/**
 * Keep D6's delivery generation with the event that was claimed. Consumers
 * must not manufacture a nonce: an absent value preserves the Phase-A
 * compatibility path until every deployed client has upgraded.
 */
const ackBodyForEvent = (event) => {
  const deliveryId = event?.payload?.deliveryId;
  return typeof deliveryId === 'string' && deliveryId ? { deliveryId } : {};
};

module.exports = { ackBodyForEvent };
