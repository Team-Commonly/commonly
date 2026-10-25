/** Shared Status and Usage timestamps follow the selected app language. */
export const formatAgentTimestamp = (value: string, language: string): string => (
  new Date(value).toLocaleString(language, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
);
