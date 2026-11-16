export interface QuickProxyInfo {
  isValid: boolean;
  protocol: string;
  host: string;
  port: number | null;
  hasAuth: boolean;
  username?: string;
  password?: string;
  formatted: string;
  detectedFormat: string;
}

export function parseProxyClient(raw: string): QuickProxyInfo {
  let input = (raw || '').trim();
  if (!input) {
    return {
      isValid: false,
      protocol: 'HTTP',
      host: '',
      port: null,
      hasAuth: false,
      formatted: '',
      detectedFormat: 'Vacío',
    };
  }

  // Quitar comillas y comentarios
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) {
    input = input.slice(1, -1).trim();
  }
  if (input.includes('#')) {
    input = input.split('#')[0].trim();
  }

  let protocol = 'HTTP';
  const lower = input.toLowerCase();
  if (lower.startsWith('socks5h://')) {
    protocol = 'SOCKS5';
    input = input.slice(10);
  } else if (lower.startsWith('socks5://')) {
    protocol = 'SOCKS5';
    input = input.slice(9);
  } else if (lower.startsWith('socks4://')) {
    protocol = 'SOCKS4';
    input = input.slice(9);
  } else if (lower.startsWith('https://')) {
    protocol = 'HTTP';
    input = input.slice(8);
  } else if (lower.startsWith('http://')) {
    protocol = 'HTTP';
    input = input.slice(7);
  }

  if (input.endsWith('/')) {
    input = input.slice(0, -1).trim();
  }

  // Caso 1: Contiene @ (user:pass@host:port o host:port@user:pass)
  if (input.includes('@')) {
    const parts = input.split('@');
    const left = (parts[0] || '').trim();
    const right = (parts[1] || '').trim();

    const rightParts = right.split(':');
    const rightPort = parseInt(rightParts[rightParts.length - 1], 10);

    if (!isNaN(rightPort) && rightPort > 0 && rightPort <= 65535) {
      // Formato user:pass@host:port
      const host = rightParts.slice(0, -1).join(':');
      const userParts = left.split(':');
      const username = userParts[0] || '';
      const password = userParts.slice(1).join(':') || '';
      return {
        isValid: true,
        protocol,
        host,
        port: rightPort,
        hasAuth: Boolean(username && password),
        username,
        password,
        formatted: `${host}:${rightPort}`,
        detectedFormat: 'user:pass@host:port',
      };
    }

    const leftParts = left.split(':');
    const leftPort = parseInt(leftParts[leftParts.length - 1], 10);
    if (!isNaN(leftPort) && leftPort > 0 && leftPort <= 65535) {
      // Formato host:port@user:pass
      const host = leftParts.slice(0, -1).join(':');
      const userParts = right.split(':');
      const username = userParts[0] || '';
      const password = userParts.slice(1).join(':') || '';
      return {
        isValid: true,
        protocol,
        host,
        port: leftPort,
        hasAuth: Boolean(username && password),
        username,
        password,
        formatted: `${host}:${leftPort}`,
        detectedFormat: 'host:port@user:pass',
      };
    }
  }

  // Caso 2: IPv6 [2001:db8::1]:8080:...
  if (input.startsWith('[')) {
    const closeBracket = input.indexOf(']');
    if (closeBracket !== -1) {
      const ipv6 = input.slice(1, closeBracket);
      const rest = input.slice(closeBracket + 1).replace(/^[:;]/, '');
      const tokens = rest.split(/[:;|,\t ]/).filter(Boolean);
      const port = parseInt(tokens[0], 10);
      if (!isNaN(port)) {
        const username = tokens[1];
        const password = tokens.slice(2).join(':');
        return {
          isValid: true,
          protocol,
          host: ipv6,
          port,
          hasAuth: Boolean(username && password),
          username,
          password,
          formatted: `[${ipv6}]:${port}`,
          detectedFormat: 'IPv6',
        };
      }
    }
  }

  // Caso 3: Delimitadores flexibles (':', ';', '|', ',', tab, espacio)
  const normalized = input.replace(/[;|,\t ]/g, ':');
  const tokens = normalized.split(':').map((s) => s.trim()).filter(Boolean);

  if (tokens.length === 2) {
    const port = parseInt(tokens[1], 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      return {
        isValid: true,
        protocol,
        host: tokens[0],
        port,
        hasAuth: false,
        formatted: `${tokens[0]}:${port}`,
        detectedFormat: 'host:port (IP abierta / Whitelist)',
      };
    }
  }

  if (tokens.length >= 4) {
    const portAt1 = parseInt(tokens[1], 10);
    const portAt3 = parseInt(tokens[3], 10);

    if (!isNaN(portAt1) && portAt1 > 0 && portAt1 <= 65535) {
      // Estándar de proveedores: host:port:user:pass
      const host = tokens[0];
      const username = tokens[2];
      const password = tokens.slice(3).join(':');
      return {
        isValid: true,
        protocol,
        host,
        port: portAt1,
        hasAuth: true,
        username,
        password,
        formatted: `${host}:${portAt1}`,
        detectedFormat: 'host:port:user:pass (Estándar)',
      };
    }

    if (!isNaN(portAt3) && portAt3 > 0 && portAt3 <= 65535) {
      // Formato alternativo: user:pass:host:port
      const username = tokens[0];
      const password = tokens[1];
      const host = tokens[2];
      return {
        isValid: true,
        protocol,
        host,
        port: portAt3,
        hasAuth: true,
        username,
        password,
        formatted: `${host}:${portAt3}`,
        detectedFormat: 'user:pass:host:port',
      };
    }
  }

  if (tokens.length === 3) {
    const portAt1 = parseInt(tokens[1], 10);
    if (!isNaN(portAt1) && portAt1 > 0 && portAt1 <= 65535) {
      return {
        isValid: true,
        protocol,
        host: tokens[0],
        port: portAt1,
        hasAuth: true,
        username: tokens[2],
        formatted: `${tokens[0]}:${portAt1}`,
        detectedFormat: 'host:port:user',
      };
    }
  }

  return {
    isValid: false,
    protocol,
    host: input,
    port: null,
    hasAuth: false,
    formatted: input,
    detectedFormat: 'Formato desconocido',
  };
}
