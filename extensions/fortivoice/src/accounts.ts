import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { FortivoiceAccountConfig, FortivoiceConfig } from "./config-schema.js";
import type { CoreConfig, ResolvedFortivoiceAccount } from "./types.js";

const DEFAULT_RECONNECT_DELAY_MS = 2_000;

function getFortivoiceConfig(cfg: CoreConfig): FortivoiceConfig | undefined {
  return cfg.channels?.fortivoice;
}

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = getFortivoiceConfig(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts)
    .map((entry) => normalizeAccountId(entry))
    .filter(Boolean);
}

function hasTopLevelConfig(cfg: CoreConfig): boolean {
  const base = getFortivoiceConfig(cfg);
  if (!base) {
    return false;
  }
  return Boolean(
    base.url ||
      base.name ||
      base.enabled !== undefined ||
      base.reconnectDelayMs !== undefined ||
      base.helloWorldOnStart !== undefined,
  );
}

function resolveAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): FortivoiceAccountConfig | undefined {
  const accounts = getFortivoiceConfig(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function mergeAccountConfig(cfg: CoreConfig, accountId: string): FortivoiceAccountConfig {
  const base = getFortivoiceConfig(cfg) ?? {};
  const { accounts: _ignored, defaultAccount: _ignoredDefault, ...shared } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return {
    ...shared,
    ...account,
  };
}

function normalizeUrl(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function listFortivoiceAccountIds(cfg: CoreConfig): string[] {
  const ids = new Set(listConfiguredAccountIds(cfg));
  if (hasTopLevelConfig(cfg) || ids.size === 0) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultFortivoiceAccountId(cfg: CoreConfig): string {
  const configured = getFortivoiceConfig(cfg)?.defaultAccount?.trim();
  if (configured) {
    return normalizeAccountId(configured);
  }
  const ids = listFortivoiceAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveFortivoiceAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedFortivoiceAccount {
  const requestedAccountId = params.accountId?.trim();
  const fallbackAccountId = resolveDefaultFortivoiceAccountId(params.cfg);
  const accountId = normalizeAccountId(requestedAccountId || fallbackAccountId);
  const merged = mergeAccountConfig(params.cfg, accountId);
  const baseEnabled = getFortivoiceConfig(params.cfg)?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const envUrl =
    accountId === DEFAULT_ACCOUNT_ID ? normalizeUrl(process.env.FORTIVOICE_WS_URL) : undefined;
  const url = normalizeUrl(merged.url) ?? envUrl;

  return {
    accountId,
    enabled,
    configured: Boolean(url),
    name: merged.name?.trim() || undefined,
    url,
    reconnectDelayMs: merged.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    helloWorldOnStart: merged.helloWorldOnStart !== false,
    config: merged,
  };
}
