import "./chrome-api";
import type { ProviderSource } from "../../shared/src";

export interface CookieSnapshot {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expirationDate?: number;
  value?: string;
}

export interface CredentialSnapshot {
  provider: ProviderSource;
  captured_at: string;
  cookies: CookieSnapshot[];
}

const providerDomains: Record<ProviderSource, string[]> = {
  chatgpt: ["chatgpt.com", "chat.openai.com", "auth.openai.com"],
  claude: ["claude.ai"],
  gemini: ["gemini.google.com", "accounts.google.com"],
};

export async function collectCredentialSnapshot(
  provider: ProviderSource,
  includeValues = false,
): Promise<CredentialSnapshot> {
  const cookies = (await Promise.all(providerDomains[provider].map((domain) => getCookies(domain)))).flat();
  return {
    provider,
    captured_at: new Date().toISOString(),
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate,
      ...(includeValues ? { value: cookie.value } : {}),
    })),
  };
}

function getCookies(domain: string): Promise<any[]> {
  return new Promise((resolve) => chrome.cookies.getAll({ domain }, resolve));
}
