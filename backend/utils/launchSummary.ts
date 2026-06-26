export const LAUNCH_MILESTONES = {
  stars: 300,
  weeklyActiveDevs: 23,
  week7Retention: 48,
};

export function formatLaunchSummary() {
  return `${LAUNCH_MILESTONES.stars}+ stars, ${LAUNCH_MILESTONES.weeklyActiveDevs} weekly devs, ${LAUNCH_MILESTONES.week7Retention}% week-7 retention`;
}
