import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import V2AuthBrand, { V2HandoffState } from './V2AuthBrand';
import V2AuthNotice from './V2AuthNotice';
import { ShellGlyph } from '../icons/glyphs';
import { PlatformGlyph } from '../icons/platforms';

// The notice's role, kept out of JSX for the i18n literal rule.
const STATUS = 'status' as const;

interface Channel {
  id: string;
  name: string;
  topic?: string;
}

interface ServerInfo {
  id: string;
  name: string | null;
}

interface V2DiscordCallbackProps {
  type?: 'callback' | 'success' | 'error';
}

// The Discord bot install's return page, drawn as the d215 s-handoff frames:
// the sign-in card with the handoff brand row. callback is working, success
// asks for the channel (done), error carries the server's line. The backend
// sends Discord back to /discord/*; App's NavigationHandler moves that to
// /v2/discord/* with its query (utils/legacyV2Path.ts), so the page renders
// inside V2App's .v2-root.
const V2DiscordCallback: React.FC<V2DiscordCallbackProps> = ({ type = 'callback' }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);

  const urlParams = new URLSearchParams(location.search);
  const podId = urlParams.get('pod_id');
  const guildId = urlParams.get('guild_id');
  const serverName = urlParams.get('server_name');
  const errorMessage = urlParams.get('error');

  useEffect(() => {
    if (type === 'success' && guildId) {
      setServerInfo({ id: guildId, name: serverName });
      fetchChannels(guildId);
    } else if (type === 'error') {
      setError(errorMessage || t('auth.discordHandoff.errorFallback'));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, guildId, serverName, errorMessage]);

  const fetchChannels = async (id: string): Promise<void> => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const response = await axios.get<Channel[]>(`/api/discord/channels/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setChannels(response.data);
    } catch (err) {
      console.error('Error fetching channels:', err);
      setError(t('auth.discordHandoff.channelsFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateIntegration = async (): Promise<void> => {
    if (!selectedChannel || !podId || !guildId) {
      setError(t('auth.discordHandoff.pickChannel'));
      return;
    }

    try {
      setLoading(true);
      setError('');

      const selectedChannelInfo = channels.find((c) => c.id === selectedChannel);
      const token = localStorage.getItem('token');

      await axios.post(
        '/api/integrations',
        {
          podId,
          type: 'discord',
          config: {
            serverId: guildId,
            serverName: serverInfo?.name,
            channelId: selectedChannel,
            channelName: selectedChannelInfo?.name || 'Unknown Channel',
            webhookUrl: '',
            botToken: '',
            permissions: ['read_messages', 'send_messages', 'read_message_history'],
          },
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      setSuccess(t('auth.discordHandoff.created'));

      try {
        const podResponse = await axios.get<{ type?: string }>(`/api/pods/${podId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const podType = podResponse.data.type || 'chat';
        setTimeout(() => navigate(`/pods/${podType}/${podId}`), 2000);
      } catch (podError) {
        console.error('Error fetching pod info, defaulting to chat:', podError);
        setTimeout(() => navigate(`/pods/chat/${podId}`), 2000);
      }
    } catch (err: unknown) {
      console.error('Error creating integration:', err);
      const e = err as { response?: { data?: { message?: string } } };
      setError(e.response?.data?.message || t('auth.discordHandoff.createFailed'));
    } finally {
      setLoading(false);
    }
  };

  const discord = (
    <span className="v2-handoff__tile v2-handoff__tile--discord">
      <PlatformGlyph type="discord" />
    </span>
  );

  const card = (state: V2HandoffState, children: React.ReactNode) => (
    <div className="v2-login">
      <div className="v2-login__card v2-login__card--stack">
        <V2AuthBrand handoff={{ state, provider: discord }} />
        {children}
      </div>
    </div>
  );

  if (type === 'error') {
    // The server's line is the URL's error param: plain text in the alert
    // row, never markup.
    return card('error', (
      <>
        <h1 className="v2-login__title">{t('auth.discordHandoff.errorTitle')}</h1>
        <V2AuthNotice>{errorMessage || t('auth.discordHandoff.errorFallback')}</V2AuthNotice>
        <button className="v2-login__submit v2-login__submit--ghost" type="button" onClick={() => navigate(-1)}>
          {t('auth.discordHandoff.back')}
        </button>
      </>
    ));
  }

  if (type === 'success') {
    return card('done', (
      <>
        <h1 className="v2-login__title">
          {success ? t('auth.discordHandoff.connectedTitle') : t('auth.discordHandoff.doneTitle')}
        </h1>
        <dl className="v2-handoff__facts">
          <div>
            <dt>{t('auth.discordHandoff.server')}</dt>
            <dd>{serverInfo?.name}</dd>
          </div>
        </dl>
        {error && <V2AuthNotice>{error}</V2AuthNotice>}
        {success && <V2AuthNotice kind={STATUS}>{success}</V2AuthNotice>}
        {!success && (
          <>
            <label className="v2-login__field">
              <span className="v2-login__label">{t('auth.discordHandoff.channel')}</span>
              <span className="v2-handoff__select">
                <select
                  className="v2-login__input"
                  value={selectedChannel}
                  onChange={(e) => setSelectedChannel(e.target.value)}
                  disabled={loading}
                >
                  <option value="" disabled>
                    {loading ? t('auth.discordHandoff.loadingChannels') : t('auth.discordHandoff.choose')}
                  </option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {`#${channel.name}${channel.topic ? ` - ${channel.topic}` : ''}`}
                    </option>
                  ))}
                </select>
                <ShellGlyph name="chevron" />
              </span>
            </label>
            <div className="v2-handoff__keys">
              <button
                className="v2-login__submit v2-login__submit--ghost"
                type="button"
                onClick={() => navigate(-1)}
                disabled={loading}
              >
                {t('auth.discordHandoff.cancel')}
              </button>
              <button
                className="v2-login__submit"
                type="button"
                onClick={handleCreateIntegration}
                disabled={loading || !selectedChannel}
              >
                {loading && channels.length ? t('auth.discordHandoff.connecting') : t('auth.discordHandoff.connect')}
              </button>
            </div>
          </>
        )}
      </>
    ));
  }

  return card('working', (
    <h1 className="v2-login__title" role="status">{t('auth.discordHandoff.workingTitle')}</h1>
  ));
};

export default V2DiscordCallback;
