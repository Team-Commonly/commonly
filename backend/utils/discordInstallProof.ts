/**
 * Discord first-install proof (F89).
 *
 * The success page's channel picker reads `GET /api/discord/channels/:guildId`,
 * which answers only for a guild already bound to one of the caller's pods. On a
 * first install nothing is bound yet, so the picker never loaded. The OAuth
 * callback is where Commonly learns which guild the bot was just added to: the
 * code exchange's token response names it. The callback has no session (Discord
 * redirects a browser there), so it hands the page a short-lived signed proof of
 * (pod, guild), and the channels route accepts that proof in place of a binding
 * when the caller belongs to the pod it names.
 *
 * The payload carries neither `id` nor `user`, so `middleware/auth` never reads
 * it as a session.
 */
import jwt, { type JwtPayload } from 'jsonwebtoken';

import { isDiscordSnowflake } from './discordBinding';

const PURPOSE = 'discord-install';
export const DISCORD_INSTALL_PROOF_TTL_SECONDS = 30 * 60;

interface DiscordInstallProofPayload extends JwtPayload {
  pur: typeof PURPOSE;
  pod: string;
  gid: string;
}

const secret = (): string => {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not set');
  return value;
};

export const mintDiscordInstallProof = (
  { podId, guildId }: { podId: string; guildId: string },
  ttlSeconds: number = DISCORD_INSTALL_PROOF_TTL_SECONDS,
): string => {
  const payload: DiscordInstallProofPayload = { pur: PURPOSE, pod: podId, gid: guildId };
  return jwt.sign(payload, secret(), { expiresIn: ttlSeconds });
};

/** The proof's (pod, guild), or null for anything that is not a live proof. */
export const readDiscordInstallProof = (token: unknown): { podId: string; guildId: string } | null => {
  if (typeof token !== 'string' || !token) return null;
  try {
    const decoded = jwt.verify(token, secret()) as DiscordInstallProofPayload;
    if (decoded.pur !== PURPOSE || typeof decoded.pod !== 'string' || !isDiscordSnowflake(decoded.gid)) return null;
    return { podId: decoded.pod, guildId: decoded.gid };
  } catch {
    return null;
  }
};
