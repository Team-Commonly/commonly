# Browser profiles for seat walks

**House rule, ruled by Sam on 2026-10-25.** A seat doing browser work for Commonly (vendor dashboards and consoles, GitHub, commonly.me, connector walks) may use the signed-in session of **any** ego lite profile on the host, the operators' own profiles included. Use `ego-browser nodejs`.

**Before asking Sam to sign in, check every profile.** List them with `await listProfiles()`, open the site in each plausible one, and confirm which account is signed in **on the site itself** (its account or profile page). "Signed out" is a claim about every profile, not the first one you tried. A reply once sat unsent for five days because the one profile holding the session was never opened.

**Never type a password, a 2FA code or card data**, in any profile. Reusing a session that is already signed in, including an existing OAuth consent, is fine. A sign-in that needs a secret goes to Sam as a decision card.

**Only the raw API honours a profile.** `newTaskSpace(name, {profile})`, `newTaskSpace(name, 'id')` and `useOrCreateTaskSpace(name, 'id')` all silently create the space on ego's default profile. Create and confirm like this:

```js
const t = await ego.createTaskSpace('<name>', '<profileId>');
(await listTaskSpaces()).find(s => s.id === t.id).profileId; // must equal <profileId>
// later runs: await useOrCreateTaskSpace(t.id) — by numeric id, it never re-creates
```

**ego profile ids are not Chrome's directory names**, and a profile's name does not tell you which account it holds. Choose by the `name` from `listProfiles()`, then confirm the account on the site before acting.
