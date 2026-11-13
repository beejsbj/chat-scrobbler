import type { AssetBackfillPage, ProviderSource } from "../../shared/src";

interface BackfillTab { id?: number; url?: string; discarded?: boolean; }

/** Gemini `blob:` media is readable only by the tab showing `/app/{source_id}` (see isGeminiPageBlob). */
const ownsGeminiChat = (tab: BackfillTab, sourceId: string) => {
  if (tab.discarded === true || !tab.url) return false;
  try { const url = new URL(tab.url); return url.origin === "https://gemini.google.com" && url.pathname === `/app/${sourceId}`; }
  catch { return false; }
};

/**
 * Splits one backfill page across a provider's tabs. ChatGPT and Claude read assets over the network, so
 * the first tab takes the whole page. Gemini sessions go to the tab that owns the chat, and any session
 * without one goes to the first live tab, which can still fetch its non-blob media. Each tab gets one request.
 */
export function routeBackfillPage(provider: ProviderSource, page: AssetBackfillPage, tabs: BackfillTab[]): Array<{ tab: BackfillTab; page: AssetBackfillPage }> {
  if (provider !== "gemini") return [{ tab: tabs[0], page }];
  const fallback = tabs.find(tab => tab.discarded !== true) ?? tabs[0];
  const groups = new Map<BackfillTab, AssetBackfillPage["sessions"]>();
  for (const session of page.sessions) {
    const tab = tabs.find(candidate => ownsGeminiChat(candidate, session.source_id)) ?? fallback;
    groups.set(tab, [...(groups.get(tab) ?? []), session]);
  }
  if (!groups.size) return [{ tab: fallback, page }];
  return [...groups].map(([tab, sessions]) => ({ tab, page: { ...page, sessions } }));
}
