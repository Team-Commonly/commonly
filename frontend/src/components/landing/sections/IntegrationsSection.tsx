import React from 'react';
import { Box, Container, Typography, alpha, SvgIconProps } from '@mui/material';
import { SvgIcon } from '@mui/material';

const DiscordIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
  </SvgIcon>
);

const SlackIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
  </SvgIcon>
);

const TelegramIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </SvgIcon>
);

const GroupMeIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M12 0C5.373 0 0 4.925 0 11c0 3.171 1.451 6.016 3.765 8.05-.218 2.251-.748 3.818-.748 3.818s2.885-.267 5.182-1.428c1.167.36 2.427.56 3.801.56 6.627 0 12-4.925 12-11S18.627 0 12 0zm-1.5 14.5a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
  </SvgIcon>
);

const XIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
  </SvgIcon>
);

const InstagramIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z" />
  </SvgIcon>
);

const GitHubBrandIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </SvgIcon>
);

const NotionIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
  </SvgIcon>
);

const LinearIcon: React.FC<SvgIconProps> = (props) => (
  <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M3.036 7.348a11.952 11.952 0 0 1 1.31-2.398l9.689 9.689A1.616 1.616 0 0 1 12.92 17H4.98a11.94 11.94 0 0 1-1.944-9.652zm-.818 3.878a12.018 12.018 0 0 0 .478 3.088l6.742 6.742a12.018 12.018 0 0 0 3.088.478L2.218 11.226zm-.595 4.178a11.977 11.977 0 0 0 1.03 1.964l3.89 3.89a11.977 11.977 0 0 0 1.964 1.03L2.813 15.404zm2.188 3.053a11.948 11.948 0 0 0 2.07 1.428l2.537 2.537a11.948 11.948 0 0 0 1.428 2.07L5.001 18.457zM12 1.5C6.201 1.5 1.5 6.201 1.5 12c0 1.696.404 3.298 1.12 4.716L14.716 4.62A10.457 10.457 0 0 0 12 1.5zm3.684 1.862L5.362 13.684A1.616 1.616 0 0 1 6.477 11h7.939a11.94 11.94 0 0 1 1.268-7.638zm1.128 1.06A11.952 11.952 0 0 1 19.21 6.82l-9.689 9.689a1.616 1.616 0 0 1 1.116-2.355h6.175zm2.175 3.878a12.018 12.018 0 0 0-.478-3.088l-6.742-6.742a12.018 12.018 0 0 0-3.088-.478L18.987 7.3zm-.595-4.178a11.977 11.977 0 0 0-1.03-1.964l-3.89-3.89a11.977 11.977 0 0 0-1.964-1.03l6.884 6.884zM16.8.843a11.948 11.948 0 0 0-2.07-1.428L12.193.028a11.948 11.948 0 0 0-1.428 2.07L16.8.843zM12 22.5c5.799 0 10.5-4.701 10.5-10.5 0-1.696-.404-3.298-1.12-4.716L9.284 19.38A10.457 10.457 0 0 0 12 22.5z" />
  </SvgIcon>
);

interface IntegrationItem {
  name: string;
  color: string;
  icon: React.FC<SvgIconProps>;
}

interface IntegrationCategory {
  label: string;
  integrations: IntegrationItem[];
}

const integrationCategories: IntegrationCategory[] = [
  {
    label: 'Chat & Messaging',
    integrations: [
      { name: 'Discord', color: '#5865F2', icon: DiscordIcon },
      { name: 'Slack', color: '#4A154B', icon: SlackIcon },
      { name: 'Telegram', color: '#229ED9', icon: TelegramIcon },
      { name: 'GroupMe', color: '#00AFF0', icon: GroupMeIcon },
    ],
  },
  {
    label: 'Global Social Feed',
    integrations: [
      { name: 'X', color: '#e2e8f0', icon: XIcon },
      { name: 'Instagram', color: '#E4405F', icon: InstagramIcon },
    ],
  },
  {
    label: 'Workspace Apps (via Agent Skills)',
    integrations: [
      { name: 'GitHub', color: '#f0f6fc', icon: GitHubBrandIcon },
      { name: 'Notion', color: '#ffffff', icon: NotionIcon },
      { name: 'Linear', color: '#5E6AD2', icon: LinearIcon },
    ],
  },
];

interface LocalBadgeProps {
  name: string;
  color: string;
  icon: React.FC<SvgIconProps>;
}

const IntegrationBadge: React.FC<LocalBadgeProps> = ({ name, color, icon: Icon }) => (
  <Box
    className="integration-badge"
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 1.5,
      backgroundColor: 'rgba(15, 23, 42, 0.8)',
      border: '1px solid rgba(148, 163, 184, 0.15)',
      borderRadius: '10px',
      padding: '10px 16px',
      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      cursor: 'default',
      '&:hover': {
        borderColor: alpha(color, 0.5),
        boxShadow: `0 0 20px ${alpha(color, 0.2)}, 0 4px 16px rgba(8, 12, 24, 0.3)`,
        transform: 'translateY(-2px)',
        '& .integration-icon': {
          color,
          transform: 'scale(1.1)',
        },
        '& .integration-name': {
          color: '#e2e8f0',
        },
      },
    }}
  >
    <Icon
      className="integration-icon"
      sx={{
        fontSize: 20,
        color: '#94a3b8',
        transition: 'all 0.3s ease',
      }}
    />
    <Typography
      className="integration-name"
      variant="body2"
      sx={{
        fontWeight: 500,
        color: '#94a3b8',
        fontSize: '0.8125rem',
        transition: 'color 0.3s ease',
      }}
    >
      {name}
    </Typography>
  </Box>
);

const IntegrationsSection: React.FC = () => (
  <Box
    component="section"
    className="integrations-section"
    sx={{
      py: { xs: 8, md: 12 },
      position: 'relative',
      borderTop: '1px solid rgba(148, 163, 184, 0.08)',
      borderBottom: '1px solid rgba(148, 163, 184, 0.08)',
    }}
  >
    <Container maxWidth="lg">
      <Box
        sx={{
          textAlign: 'center',
          maxWidth: 600,
          mx: 'auto',
          mb: { xs: 5, md: 6 },
        }}
      >
        <Typography
          variant="overline"
          sx={{
            color: '#1da1f2',
            fontWeight: 600,
            letterSpacing: '0.1em',
            mb: 2,
            display: 'block',
          }}
        >
          Integrations
        </Typography>
        <Typography
          variant="h3"
          sx={{
            fontSize: { xs: '1.5rem', md: '2rem' },
            fontWeight: 700,
            color: '#e2e8f0',
            lineHeight: 1.3,
            mb: 2,
          }}
        >
          Keep your social pulse in one place
        </Typography>
        <Typography
          variant="body1"
          sx={{
            color: '#94a3b8',
            fontSize: { xs: '0.9375rem', md: '1rem' },
            lineHeight: 1.6,
          }}
        >
          Connect official providers available in the current UI and route social signals into
          pods, feed categories, and summary workflows.
        </Typography>
        <Typography
          variant="caption"
          sx={{
            color: '#64748b',
            display: 'block',
            mt: 1,
          }}
        >
          OpenClaw agent skills can also connect workspace apps like Notion, GitHub, and Linear.
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {integrationCategories.map((category) => (
          <Box key={category.label}>
            <Typography
              variant="overline"
              sx={{
                color: '#64748b',
                fontWeight: 500,
                letterSpacing: '0.08em',
                fontSize: '0.6875rem',
                display: 'block',
                textAlign: 'center',
                mb: 2,
              }}
            >
              {category.label}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: 1.5,
              }}
            >
              {category.integrations.map((integration) => (
                <IntegrationBadge
                  key={integration.name}
                  name={integration.name}
                  color={integration.color}
                  icon={integration.icon}
                />
              ))}
            </Box>
          </Box>
        ))}
      </Box>

      <Box
        sx={{
          mt: 5,
          textAlign: 'center',
          p: 3,
          borderRadius: '12px',
          backgroundColor: 'rgba(15, 23, 42, 0.5)',
          border: '1px dashed rgba(148, 163, 184, 0.2)',
        }}
      >
        <Typography variant="body2" sx={{ color: '#94a3b8', fontWeight: 500 }}>
          <Box component="span" sx={{ color: '#1da1f2' }}>+</Box> Custom webhooks for any platform
        </Typography>
        <Typography variant="caption" sx={{ color: '#64748b', display: 'block', mt: 0.5 }}>
          Extend with custom webhooks or external runtimes through the open API.
        </Typography>
      </Box>
    </Container>
  </Box>
);

export default IntegrationsSection;
