import OnboardingSilenceEpisode from '../models/OnboardingSilenceEpisode';
import {
  scan, ROLLUP_COLLAPSE_THRESHOLD, SILENCE_THRESHOLD_MINUTES, SilenceEpisodeSummary, ScanResult,
} from './onboardingSilenceService';

/**
 * Delivery for the onboarding-silence alert.
 *
 * Split from detection because they fail for different reasons and only one of
 * them is allowed to be quiet: a detection bug means we do not know onboarding
 * broke, a delivery bug means we knew and did not say. Keeping them in one
 * function would have let an SMTP outage look identical to a healthy funnel.
 *
 * THIS SERVICE REFUSES TO BE SILENTLY INERT. If no recipient is configured it
 * says so, loudly, on every pass that had something to report — rather than
 * computing episodes correctly and dropping them on the floor with a success
 * return. Three of the eight defects found on 2026-08-14 were exactly that
 * shape (an at-cap decline returning `succeeded`, a claim that swallowed a
 * message, a summarizer failing on a cron for a month), and an alerting
 * service that can be silently disabled is the worst possible place to add a
 * fourth.
 */

const RECIPIENT = () => (process.env.ONBOARDING_ALERT_EMAIL || '').trim();
const ROLLING_WINDOW_MS = 60 * 60 * 1000;

/**
 * Machine-readable, one line per episode, always emitted.
 *
 * The email needs configuration and can bounce; this cannot. It is what makes
 * the alert greppable in `kubectl logs` and what a future log-based monitor
 * would key on, so it stays even when email works.
 */
const logEpisode = (e: SilenceEpisodeSummary, delivery: string): void => {
  const snap = e.eventSnapshot;
  console.error(
    '[onboarding-silence] ALERT'
    + ` user=${e.username || e.userId}`
    + ` userId=${e.userId}`
    + ` pod=${e.podName || e.podId}`
    + ` podId=${e.podId}`
    + ` messageId=${e.firstMessageId}`
    + ` typedAt=${e.firstTypedAt.toISOString()}`
    + ` accountAgeMin=${e.accountAgeMinutes}`
    + ` messages=${e.messageCount}`
    + ` events=${snap ? snap.total : 'unknown'}`
    + ` eventStatus=${snap ? JSON.stringify(snap.byStatus) : '{}'}`
    + ` diagnosis=${diagnose(e)}`
    + ` delivery=${delivery}`,
  );
};

/**
 * The one inference this service makes, and it is only possible before the
 * 30-minute pending-GC deletes the evidence.
 *
 * `never-enqueued` and `enqueued-never-answered` need opposite fixes — a
 * producer bug in the write path versus a runtime that did not run — and after
 * GC both look like an empty queue. Naming it at fire time is the whole reason
 * the snapshot is taken.
 */
export const diagnose = (e: SilenceEpisodeSummary): string => {
  if (!e.eventSnapshot) return 'unknown';
  if (e.eventSnapshot.noneEnqueued) return 'never-enqueued';
  const { byStatus, runsStarted } = e.eventSnapshot;
  if ((byStatus.acked || 0) > 0) {
    // "Acked and no reply" is not one fault. With no AgentRun the runtime
    // never started: it declined at its daily cap (which returns
    // `succeeded` before writing a run row) or another agent won the claim
    // and this seat stood down. With a run, it started and produced nothing
    // — a different investigation entirely. Reporting both as one label
    // would make the at-cap case read as a runtime failure, and ADR-022 D5
    // makes at-cap more common rather than less.
    return (runsStarted || 0) > 0 ? 'ran-but-silent' : 'acked-never-ran';
  }
  if ((byStatus.failed || 0) > 0) return 'event-failed';
  return 'enqueued-never-answered';
};

const line = (e: SilenceEpisodeSummary): string =>
  `- ${e.username || e.userId} in "${e.podName || e.podId}"`
  + ` — typed ${e.messageCount} message(s), first at ${e.firstTypedAt.toISOString()},`
  + ` ${e.accountAgeMinutes} min after signing up. Diagnosis: ${diagnose(e)}.`;

const sendMail = async (subject: string, text: string): Promise<boolean> => {
  const to = RECIPIENT();
  if (!to) return false;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { sendEmail } = require('./emailService');
    await sendEmail({
      to,
      subject,
      textBody: text,
      htmlBody: `<pre style="font:14px ui-monospace,monospace">${
        text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))
      }</pre>`,
    });
    return true;
  } catch (error) {
    console.error('[onboarding-silence] delivery FAILED:', (error as Error).message);
    return false;
  }
};

/**
 * Run one detection pass and deliver whatever it opened.
 *
 * Above ROLLUP_COLLAPSE_THRESHOLD new episodes in a rolling hour, individual
 * mails collapse into one rollup — the base rate is ~1/day on a working
 * system, but the failure this watches for is a regression, and a regression
 * strands users in bulk.
 */
export const runOnce = async (
  opts: Parameters<typeof scan>[0] = {},
): Promise<ScanResult & { delivered: number; rollup: boolean; unconfigured: boolean }> => {
  const now = opts.now || new Date();
  const result = await scan({ ...opts, now });

  if (result.resolved.length > 0) {
    for (const r of result.resolved) {
      console.log(
        `[onboarding-silence] resolved episode=${r.episodeId}`
        + ` outcome=${r.outcome} lagSeconds=${r.lagSeconds}`,
      );
    }
  }

  if (result.opened.length === 0) {
    return {
      ...result, delivered: 0, rollup: false, unconfigured: false,
    };
  }

  // Rolling-hour pressure includes episodes opened by earlier passes, or a
  // burst spread across ticks would slip under the threshold on every one.
  const recentCount = await OnboardingSilenceEpisode.countDocuments({
    detectedAt: { $gte: new Date(now.getTime() - ROLLING_WINDOW_MS) },
  });
  const rollup = recentCount > ROLLUP_COLLAPSE_THRESHOLD;

  const configured = Boolean(RECIPIENT());
  if (!configured) {
    console.error(
      `[onboarding-silence] ${result.opened.length} stranded user(s) detected and NO ALERT`
      + ' RECIPIENT IS CONFIGURED — set ONBOARDING_ALERT_EMAIL. Episodes are recorded and'
      + ' readable at GET /api/admin/analytics/silence, but nothing was sent.',
    );
  }

  let delivered = 0;
  if (rollup) {
    const body = `${result.opened.length} new stranded user(s) in this pass;`
      + ` ${recentCount} in the last hour. Collapsed to one alert.\n\n`
      + `${result.opened.map(line).join('\n')}\n\n`
      + `Threshold: ${SILENCE_THRESHOLD_MINUTES} min with no reply from any agent.\n`
      + 'A burst usually means a regression rather than N unlucky users.';
    if (await sendMail(
      `[Commonly] ${result.opened.length} users typed and got no reply`, body,
    )) delivered = 1;
    for (const e of result.opened) logEpisode(e, rollup ? 'rollup' : 'none');
    await OnboardingSilenceEpisode.updateMany(
      { _id: { $in: result.opened.map((e) => e.episodeId) } },
      { $set: { collapsedIntoRollup: true, alertSentAt: delivered ? now : undefined } },
    );
  } else {
    for (const e of result.opened) {
      const body = `${line(e)}\n\n`
        + `They signed up, said something, and nothing answered within ${SILENCE_THRESHOLD_MINUTES} minutes.\n\n`
        + `Pod: ${e.podName || ''} (${e.podId})\n`
        + `Agent events in that pod after they typed: ${e.eventSnapshot?.total ?? 'unknown'}`
        + `${e.eventSnapshot?.targets?.length ? ` -> ${e.eventSnapshot.targets.join(', ')}` : ''}\n`
        + `Diagnosis: ${diagnose(e)}\n\n`
        + '"never-enqueued" points at the write path (a producer bug); '
        + '"enqueued-never-answered" points at the runtime.';
      const ok = await sendMail(
        `[Commonly] ${e.username || 'A new user'} typed and got no reply`, body,
      );
      if (ok) {
        delivered += 1;
        await OnboardingSilenceEpisode.updateOne(
          { _id: e.episodeId }, { $set: { alertSentAt: now } },
        );
      }
      logEpisode(e, ok ? 'email' : 'log-only');
    }
  }

  return {
    ...result, delivered, rollup, unconfigured: !configured,
  };
};

export default { runOnce, diagnose };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
