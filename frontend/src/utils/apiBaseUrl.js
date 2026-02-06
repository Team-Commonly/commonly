const getApiBaseUrl = () => {
  if (process.env.REACT_APP_API_URL) {
    if (typeof window !== 'undefined') {
      const envUrl = process.env.REACT_APP_API_URL;
      const pageProtocol = window.location?.protocol || '';
      if (pageProtocol === 'https:' && envUrl.startsWith('http://')) {
        // Avoid mixed content when a legacy http build arg is present.
      } else {
        return envUrl;
      }
    } else {
      return process.env.REACT_APP_API_URL;
    }
  }

  if (typeof window === 'undefined') {
    return 'http://localhost:5000';
  }

  const { protocol, hostname } = window.location;

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:5000';
  }

  if (hostname.startsWith('app-dev.')) {
    return `${protocol}//api-dev.${hostname.slice('app-dev.'.length)}`;
  }

  if (hostname.startsWith('app.')) {
    return `${protocol}//api.${hostname.slice('app.'.length)}`;
  }

  return `${protocol}//${hostname}`;
};

const normalizeUploadUrl = (value) => {
  if (!value || typeof value !== 'string') return value;
  if (value.startsWith('data:image/')) return value;

  const apiBase = getApiBaseUrl();

  if (value.startsWith('/api/uploads/') || value.startsWith('/uploads/')) {
    return `${apiBase}${value.startsWith('/') ? '' : '/'}${value}`;
  }

  if (value.startsWith('http://localhost:5000') || value.startsWith('https://localhost:5000')) {
    return `${apiBase}${value.replace(/^https?:\/\/localhost:5000/, '')}`;
  }
  if (value.startsWith('http://127.0.0.1:5000') || value.startsWith('https://127.0.0.1:5000')) {
    return `${apiBase}${value.replace(/^https?:\/\/127.0.0.1:5000/, '')}`;
  }

  try {
    const parsed = new URL(value);
    if (parsed.pathname.startsWith('/api/uploads/') || parsed.pathname.startsWith('/uploads/')) {
      if (parsed.hostname.startsWith('app-dev.')) {
        parsed.hostname = `api-dev.${parsed.hostname.slice('app-dev.'.length)}`;
        return parsed.toString();
      }
      if (parsed.hostname.startsWith('app.')) {
        parsed.hostname = `api.${parsed.hostname.slice('app.'.length)}`;
        return parsed.toString();
      }
    }
  } catch (err) {
    // Leave as-is when URL parsing fails.
  }

  return value;
};

export { normalizeUploadUrl };
export default getApiBaseUrl;
