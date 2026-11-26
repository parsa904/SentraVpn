export interface SingboxConfigValidationResult {
  valid: boolean;
  errors: string[];
  config: Record<string, unknown>;
}

/**
 * Translates raw Fetch / Network / HTTP errors into clear Persian user-facing messages.
 */
export function translateNetworkErrorToPersian(error: unknown, statusCode?: number): string {
  if (typeof statusCode === 'number') {
    if (statusCode === 401) {
      return 'نشست کاربری یا توکن اشتراک معتبر نیست. لطفاً دوباره وارد حساب خود شوید.';
    }
    if (statusCode === 402 || statusCode === 429) {
      return 'سهمیه مصرفی یا تعداد درخواست‌های شما به سقف مجاز رسیده است.';
    }
    if (statusCode === 403) {
      return 'اشتراک شما غیرفعال است یا دسترسی به این حالت برای پلن فعلی مجاز نیست.';
    }
    if (statusCode === 404) {
      return 'لینک اشتراک یا سرویس درخواستی در سرور یافت نشد.';
    }
    if (statusCode >= 500) {
      return `سرور مرکزی سنترا موقتاً با خطا مواجه شد (کد ${statusCode}). لطفاً لحظاتی دیگر دوباره تلاش کنید.`;
    }
  }

  const raw = error instanceof Error ? error.message : String(error ?? '');
  const lower = raw.toLowerCase();

  if (
    lower.includes('abort') ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    return 'پاسخ‌دهی سرور سنترا بیش از حد طول کشید (Timeout). لطفاً اتصال اینترنت خود را بررسی کرده و دوباره تلاش کنید.';
  }

  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('load failed') ||
    lower.includes('err_name_not_resolved') ||
    lower.includes('econnrefused') ||
    lower.includes('network request failed')
  ) {
    return 'ارتباط با سرور مرکزی سنترا برقرار نشد. لطفاً اتصال اینترنت یا تنظیمات DNS دستگاه خود را بررسی کنید.';
  }

  if (lower.includes('unexpected token') || lower.includes('json')) {
    return 'پاسخ دریافتی از سرور سنترا قالب معتبر JSON نداشت. لطفاً دوباره تلاش کنید.';
  }

  // Return original message if it is already Persian or meaningful
  if (/[\u0600-\u06FF]/.test(raw) && raw.trim().length > 0) {
    return raw.trim();
  }

  return 'خطایی در ارتباط با سرور مرکزی سنترا رخ داد. لطفاً اتصال اینترنت خود را بررسی کنید.';
}

/**
 * Extracts the sing-box JSON configuration object from either:
 * - POST /api/v1/client/config response (`{ singbox_config, config }`)
 * - GET /sub/{token}?format=singbox raw JSON response (`{ log, dns, inbounds, outbounds, route }`)
 */
export function extractSingboxConfig(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('ساختار پیکربندی دریافتی از سرور نامعتبر است.');
  }

  const record = payload as Record<string, unknown>;
  const nested = record.singbox_config ?? record.config;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return structuredClone(nested as Record<string, unknown>);
  }

  if (Array.isArray(record.outbounds) || record.route) {
    return structuredClone(record);
  }

  throw new Error('پیکربندی sing-box در پاسخ سرور یافت نشد.');
}

/**
 * Normalizes a sing-box configuration object to strict sing-box 1.14+ schema:
 * - Removes deprecated `dns.independent_cache` and legacy `dns.fakeip` block
 * - Migrates TUN `inet4_address`/`inet6_address` to `address` array and removes legacy inbound `sniff`
 * - Replaces deprecated `dns-out` outbound and `{ protocol: "dns", outbound: "dns-out" }` with `action: "hijack-dns"`
 * - Removes deprecated `block` outbound and replaces `{ outbound: "block" }` with `action: "reject"`
 */
export function normalizeToSingbox114(
  rawConfig: Record<string, unknown>
): Record<string, unknown> {
  const config = structuredClone(rawConfig);

  // 1. Normalize DNS block
  if (config.dns && typeof config.dns === 'object' && !Array.isArray(config.dns)) {
    const dns = config.dns as Record<string, unknown>;
    delete dns.independent_cache;
    const legacyFakeip = dns.fakeip as
      | { enabled?: boolean; inet4_range?: string; inet6_range?: string }
      | undefined;
    delete dns.fakeip;

    if (Array.isArray(dns.servers)) {
      dns.servers = dns.servers
        .filter((srv): srv is Record<string, unknown> => Boolean(srv && typeof srv === 'object'))
        .map((srv) => {
          if (typeof srv.type === 'string' && srv.type.length > 0) {
            return srv;
          }
          const addr = String(srv.address || '').trim();
          const tag = String(srv.tag || 'dns-server');
          if (addr === 'fakeip') {
            return {
              type: 'fakeip',
              tag,
              inet4_range: legacyFakeip?.inet4_range || '198.18.0.0/15',
              inet6_range: legacyFakeip?.inet6_range || 'fc00::/18',
            };
          }
          if (addr === 'local') {
            return { type: 'local', tag };
          }
          if (addr.startsWith('https://')) {
            try {
              const u = new URL(addr);
              return {
                type: 'https',
                tag,
                server: u.hostname,
                server_port: u.port ? Number(u.port) : 443,
                path: u.pathname || '/dns-query',
                ...(srv.detour ? { detour: srv.detour } : {}),
              };
            } catch {
              return { type: 'https', tag, server: '1.1.1.1', server_port: 443, path: '/dns-query' };
            }
          }
          if (addr.startsWith('udp://')) {
            const host = addr.slice('udp://'.length).split(':')[0] || '1.1.1.1';
            return {
              type: 'udp',
              tag,
              server: host,
              server_port: 53,
              ...(srv.detour ? { detour: srv.detour } : {}),
            };
          }
          return srv;
        });
    }
  }

  // 2. Normalize TUN inbounds
  if (Array.isArray(config.inbounds)) {
    config.inbounds = config.inbounds.map((ib) => {
      if (!ib || typeof ib !== 'object' || Array.isArray(ib)) return ib;
      const obj = { ...(ib as Record<string, unknown>) };
      if (obj.type === 'tun') {
        if (!Array.isArray(obj.address)) {
          const addrs: string[] = [];
          if (typeof obj.inet4_address === 'string') addrs.push(obj.inet4_address);
          if (typeof obj.inet6_address === 'string') addrs.push(obj.inet6_address);
          if (addrs.length > 0) obj.address = addrs;
        }
        delete obj.inet4_address;
        delete obj.inet6_address;
        delete obj.sniff;
        delete obj.sniff_override_destination;
      }
      return obj;
    });
  }

  // 3. Remove deprecated dns / block outbounds
  if (Array.isArray(config.outbounds)) {
    config.outbounds = config.outbounds.filter((ob) => {
      if (!ob || typeof ob !== 'object' || Array.isArray(ob)) return false;
      const t = String((ob as Record<string, unknown>).type || '').toLowerCase();
      return t !== 'dns' && t !== 'block';
    });
  }

  // 4. Normalize route rules to 1.14+ actions
  if (config.route && typeof config.route === 'object' && !Array.isArray(config.route)) {
    const route = config.route as Record<string, unknown>;
    if (Array.isArray(route.rules)) {
      route.rules = route.rules.map((rule) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return rule;
        const r = { ...(rule as Record<string, unknown>) };
        if (r.outbound === 'dns-out' || (r.protocol === 'dns' && !r.action)) {
          delete r.outbound;
          r.action = 'hijack-dns';
        } else if (r.outbound === 'block') {
          delete r.outbound;
          r.action = 'reject';
        }
        return r;
      });
    }
  }

  return config;
}

/**
 * Validates that a sing-box configuration strictly conforms to sing-box 1.14+ requirements.
 */
export function validateSingbox114Config(
  rawConfig: Record<string, unknown>
): SingboxConfigValidationResult {
  const config = normalizeToSingbox114(rawConfig);
  const errors: string[] = [];

  if (!Array.isArray(config.outbounds) || config.outbounds.length === 0) {
    errors.push('لیست outbounds در پیکربندی sing-box خالی است.');
  } else {
    for (const ob of config.outbounds) {
      if (!ob || typeof ob !== 'object') continue;
      const type = String((ob as Record<string, unknown>).type || '');
      if (type === 'dns' || type === 'block') {
        errors.push(`نوع outbound منسوخ‌شده (${type}) در sing-box 1.14+ مجاز نیست.`);
      }
    }
  }

  if (!config.route || typeof config.route !== 'object') {
    errors.push('بخش route در پیکربندی sing-box وجود ندارد.');
  }

  if (config.dns && typeof config.dns === 'object') {
    const dns = config.dns as Record<string, unknown>;
    if ('independent_cache' in dns) {
      errors.push('فیلد منسوخ‌شده dns.independent_cache در sing-box 1.14+ مجاز نیست.');
    }
    if (Array.isArray(dns.servers)) {
      for (const srv of dns.servers) {
        if (!srv || typeof srv !== 'object' || typeof (srv as Record<string, unknown>).type !== 'string') {
          errors.push('سرورهای DNS در sing-box 1.14+ باید دارای فیلد type باشند.');
          break;
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    config,
  };
}
