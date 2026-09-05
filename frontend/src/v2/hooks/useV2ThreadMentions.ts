import { useCallback, useMemo, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { V2Agent } from './useV2PodDetail';
import type { V2PodMember } from './useV2Pods';
import type { V2ComposerMention, V2ComposerWarning } from '../components/V2Composer';
import {
  buildAgentUsername,
  isOpaqueInstanceToken,
  rawAgentName,
  slugifyAgentHandle,
} from '../utils/threadAgentIdentity';

type MentionReachState = 'listening' | 'gone-dark' | 'never-connected' | 'reachable' | 'unknown';

interface MentionAgentState {
  state: MentionReachState;
  fixCommand?: string;
}

interface MentionItem extends V2ComposerMention {
  labelLower: string;
  isAgent: boolean;
  reach?: MentionReachState;
}

interface UseV2ThreadMentionsArgs {
  members: V2PodMember[];
  agents: V2Agent[];
  agentStateByHandle: Map<string, MentionAgentState>;
  draft: string;
  setDraft: (value: string | ((current: string) => string)) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
}

const getMentionContext = (text: string, cursor: number | null): { start: number; query: string } | null => {
  if (!text || cursor == null) return null;
  const atIndex = text.lastIndexOf('@', cursor - 1);
  if (atIndex < 0) return null;
  const beforeChar = text[atIndex - 1];
  if (beforeChar && !/\s|[([{"'`]/.test(beforeChar)) return null;
  const between = text.slice(atIndex + 1, cursor);
  if (/\s/.test(between)) return null;
  return { start: atIndex, query: between };
};

/** Composer-only mention state: candidates, reachability warnings, and insertion. */
export const useV2ThreadMentions = ({
  members,
  agents,
  agentStateByHandle,
  draft,
  setDraft,
  inputRef,
}: UseV2ThreadMentionsArgs) => {
  const { t } = useTranslation();
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionIndex, setMentionIndex] = useState(0);

  const mentionableItems = useMemo<MentionItem[]>(() => {
    const items: MentionItem[] = [];
    const seen = new Set<string>();
    const agentByUsername = new Map<string, V2Agent>();
    agents.forEach((agent) => {
      const name = rawAgentName(agent);
      if (name) agentByUsername.set(buildAgentUsername(name, agent.instanceId), agent);
    });

    const itemFromAgent = (agent: V2Agent, fallbackAvatar: string | null = null): MentionItem | null => {
      const name = rawAgentName(agent);
      if (!name) return null;
      const username = buildAgentUsername(name, agent.instanceId);
      const label = agent.displayName || agent.profile?.displayName || name;
      const instance = (agent.instanceId || 'default').toLowerCase();
      const value = instance && instance !== 'default' && instance !== name.toLowerCase()
        && !isOpaqueInstanceToken(instance)
        ? instance
        : (slugifyAgentHandle(label) || name.toLowerCase());
      const reach = agentStateByHandle.get(value)?.state || agentStateByHandle.get(name.toLowerCase())?.state;
      const subtitle = reach === 'never-connected'
        ? t('podChat.mentionState.typeaheadNever', { handle: value })
        : reach === 'gone-dark'
          ? t('podChat.mentionState.typeaheadDark', { handle: value })
          : t('podChat.mentions.agentSubtitle', { handle: value });
      return {
        id: username,
        label,
        labelLower: `${label} ${name} ${username} ${value}`.toLowerCase(),
        subtitle,
        avatar: agent.profile?.avatarUrl || agent.profile?.iconUrl || agent.iconUrl || fallbackAvatar,
        isAgent: true,
        value,
        reach,
      };
    };

    members.forEach((member) => {
      const username = member.username || '';
      if (!username) return;
      const key = username.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const agent = agentByUsername.get(key);
      if (agent) {
        const item = itemFromAgent(agent, member.profilePicture || null);
        if (item) items.push(item);
        return;
      }
      items.push({
        id: member._id || username,
        label: username,
        labelLower: username.toLowerCase(),
        subtitle: t('podChat.mentions.member'),
        avatar: member.profilePicture || null,
        isAgent: false,
        value: username,
      });
    });

    agents.forEach((agent) => {
      const name = rawAgentName(agent);
      if (!name) return;
      const username = buildAgentUsername(name, agent.instanceId);
      if (seen.has(username)) return;
      seen.add(username);
      const item = itemFromAgent(agent);
      if (item) items.push(item);
    });
    return items;
  }, [agentStateByHandle, agents, members, t]);

  const warnings = useMemo<V2ComposerWarning[]>(() => {
    if (!draft.includes('@')) return [];
    const tokens: string[] = draft.match(/@([a-z0-9][\w-]*)/gi) || [];
    const seen = new Set<string>();
    return tokens.reduce<V2ComposerWarning[]>((rows, token) => {
      const agentName = token.slice(1).toLowerCase();
      const state = agentStateByHandle.get(agentName);
      if (!state || (state.state !== 'gone-dark' && state.state !== 'never-connected') || seen.has(agentName)) {
        return rows;
      }
      seen.add(agentName);
      rows.push({ agentName, state: state.state, fixCommand: state.fixCommand });
      return rows;
    }, []);
  }, [agentStateByHandle, draft]);

  const filteredMentions = useMemo(() => {
    if (!mentionOpen) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionableItems.filter((item) => item.labelLower.includes(query)).slice(0, 8);
  }, [mentionOpen, mentionQuery, mentionableItems]);

  const updateMentionState = useCallback((nextValue: string, cursorPosition: number | null) => {
    const context = getMentionContext(nextValue, cursorPosition);
    if (!context) {
      setMentionOpen(false);
      setMentionQuery('');
      setMentionStart(-1);
      return;
    }
    setMentionOpen(true);
    setMentionQuery(context.query);
    setMentionStart(context.start);
    setMentionIndex(0);
  }, []);

  const selectMention = useCallback((item: V2ComposerMention) => {
    const input = inputRef.current;
    if (!input) return;
    const cursor = input.selectionStart ?? draft.length;
    const start = mentionStart >= 0 ? mentionStart : draft.lastIndexOf('@', cursor);
    if (start < 0) return;
    const insert = `@${item.value || item.label}`;
    setDraft(`${draft.slice(0, start)}${insert} ${draft.slice(cursor)}`);
    setMentionOpen(false);
    setMentionQuery('');
    setMentionStart(-1);
    requestAnimationFrame(() => {
      const nextCursor = start + insert.length + 1;
      input.focus();
      input.setSelectionRange(nextCursor, nextCursor);
    });
  }, [draft, inputRef, mentionStart, setDraft]);

  return {
    mentionOpen,
    setMentionOpen,
    mentionIndex,
    setMentionIndex,
    filteredMentions,
    warnings,
    updateMentionState,
    selectMention,
  };
};

export default useV2ThreadMentions;
