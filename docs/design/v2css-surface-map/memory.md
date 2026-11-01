# v2.css map: Agent memory

Generated 2026-11-01 from v2.css at main `323595193`, with live DOM read on prod `9460865ab`. Method and caveats: [README](README.md).

- **Goes with the lift:** 0 selectors used only by this surface (0 in 0 whole rules, about 0 lines; 0 sit in a rule shared with other selectors, so trim them from its list).
- **Shared, stays:** 57 selectors this surface uses that another surface also uses.
- 0 of the surface-only selectors were never matched on prod in the states walked; they are classed by source references alone. Check those before deleting.

## Goes with the lift (surface-only)

Line numbers are v2.css at `323595193`; they shift as earlier lines change, so search by selector.


## Shared, stays

Each line names the other surfaces that use the selector. It can go only when the last of them lifts.

- L395 `.v2-root *` — also agentSettings, board, chat, connectors, legacy, other, settings, shell, sidebar
- L395 `.v2-root *::before` — also agentSettings, board, chat, connectors, legacy, other, settings, shell, sidebar
- L395 `.v2-root *::after` — also agentSettings, board, chat, connectors, legacy, other, settings, shell, sidebar
- L405 `.v2-root *::-webkit-scrollbar` — also agentSettings, board, chat, connectors, legacy, other, settings, shell, sidebar
- L409 `.v2-root *::-webkit-scrollbar-track` — also agentSettings, board, chat, connectors, legacy, other, settings, shell, sidebar
- L412 `.v2-root *::-webkit-scrollbar-thumb` — also agentSettings, board, chat, connectors, legacy, other, settings, shell, sidebar
- L418 `.v2-root *::-webkit-scrollbar-thumb:hover` — also agentSettings, board, chat, connectors, legacy, other, settings, shell, sidebar
- L423 `.v2-root *::-webkit-scrollbar-corner` — also agentSettings, board, chat, connectors, legacy, other, settings, shell, sidebar
- L427 `.v2-root *` — also agentSettings, board, chat, connectors, legacy, other, settings, shell, sidebar
- L441 `.v2-root input` — also agentSettings, chat, connectors, legacy, other, settings, shell, sidebar
- L447 `.v2-root a` — also agentSettings, chat, legacy, other, settings, shell, sidebar
- L614 `.v2-root input:focus-visible` — also agentSettings, chat, connectors, legacy, other, settings, shell, sidebar
- L614 `.v2-root a:focus-visible` — also agentSettings, chat, legacy, other, settings, shell, sidebar
- L650 `.v2-authenticated-shell__content .v2-pane` — also agentSettings, board, chat, connectors, other, settings, sidebar
- L745 `.v2-pane` — also agentSettings, board, chat, connectors, other, settings, sidebar
- L764 `.v2-pane--main` — also agentSettings, board, chat, connectors, other, settings
- L773 `.v2-authenticated-shell .v2-pane--main` — also agentSettings, board, chat, connectors, other, settings
- L1020 `.v2-rail__account .v2-avatar` — also board, chat, other, settings, sidebar
- L3020 `.v2-thread .v2-system-action-line .v2-avatar` — also board, chat, other, settings, sidebar
- L5206 `.v2-avatar` — also board, chat, other, settings, sidebar
- L5236 `.v2-avatar:has(img)` — also board, chat, other, settings, sidebar
- L5243 `.v2-avatar:has(img).v2-avatar--character:not(.v2-avatar--flat)` — also board, chat, other, settings, sidebar
- L5247 `.v2-avatar--lg` — also board, chat, other, settings, sidebar
- L5253 `.v2-avatar--md` — also board, chat, other, settings, sidebar
- L5259 `.v2-avatar--sm` — also board, chat, other, settings, sidebar
- L5265 `.v2-avatar__online` — also board, chat, other, settings, sidebar
- L5518 `.v2-feature` — also agentSettings, board, connectors, other, settings, shell
- L5613 `.v2-feature__body` — also agentSettings, board, connectors, other, settings
- L5620 `.v2-feature__legacy` — also agentSettings, board, connectors, other, settings
- L5948 `.v2-feature__legacy [style*="background: linear-gradient"]` — also board, other, settings
- L6094 `.v2-pane--main` in `@media (max-width: 760px)` — also agentSettings, board, chat, connectors, other, settings
- L6094 `.v2-authenticated-shell .v2-pane--main` in `@media (max-width: 760px)` — also agentSettings, board, chat, connectors, other, settings
- L6573 `.v2-byo__layout .v2-avatar` — also board, chat, other, settings, sidebar
- L6582 `.v2-byo__layout .v2-avatar__online` — also board, chat, other, settings, sidebar
- L7557 `.v2-root input` in `@media (hover: none), (pointer: coarse)` — also agentSettings, chat, connectors, legacy, other, settings, shell, sidebar
- L11269 `.v2-shell .v2-pane` — also agentSettings, board, chat, connectors, other, settings, sidebar
- L11274 `.v2-shell .v2-pane--main` — also agentSettings, board, chat, connectors, other, settings
- L11294 `.v2-shell .v2-pane` in `@media (max-width: 760px)` — also agentSettings, board, chat, connectors, other, settings, sidebar
- L11309 `.v2-authenticated-shell__content .v2-shell .v2-pane` in `@media (max-width: 760px)` — also agentSettings, board, chat, connectors, other, settings, sidebar
- L11455 `.v2-workspace-inspector__fold-avatar.v2-avatar` — also board, chat, other, settings, sidebar
- L11515 `.v2-workspace-inspector__avatar.v2-avatar` — also board, chat, other, settings, sidebar
- L11866 `.v2-thread .v2-avatar` — also board, chat, other, settings, sidebar
- L11880 `.v2-thread .v2-chat__typing-avatars .v2-avatar` — also board, chat, other, settings, sidebar
- L11946 `.v2-pane--main` in `@media (max-width: 760px)` — also agentSettings, board, chat, connectors, other, settings
- L12361 `.v2-pods__row-mark.v2-avatar` — also board, chat, other, settings, sidebar
- L12455 `.v2-thread .v2-pod-header__stack .v2-avatar` — also board, chat, other, settings, sidebar
- L12462 `.v2-thread .v2-pod-header__stack .v2-avatar + .v2-avatar` — also board, chat, other, settings, sidebar
- L12648 `.v2-feature` in `@media (max-width: 760px)` — also agentSettings, board, connectors, other, settings, shell
- L13299 `.v2-thread .v2-thread-card__faces .v2-avatar` — also board, chat, other, settings, sidebar
- L13316 `.v2-thread .v2-thread-replies .v2-msg .v2-avatar` — also board, chat, other, settings, sidebar
- L13351 `.v2-thread .v2-avatar--flat` — also board, chat, other, settings, sidebar
- L13352 `.v2-thread .v2-avatar--flat-human` — also board, chat, other, settings, sidebar
- L13353 `.v2-thread .v2-avatar--flat-agent` — also board, chat, other, settings, sidebar
- L13354 `.v2-thread .v2-thread-replies .v2-msg .v2-avatar--flat` — also board, chat, other, settings, sidebar
- L13355 `.v2-thread .v2-thread-card__faces .v2-avatar--flat` — also board, chat, other, settings, sidebar
- L13673 `.v2-root button.v2-team-card__mark .v2-avatar` — also board, chat, other, settings, sidebar
- L14071 `.v2-feature__body` in `@media (max-width: 760px)` — also agentSettings, board, connectors, other, settings
