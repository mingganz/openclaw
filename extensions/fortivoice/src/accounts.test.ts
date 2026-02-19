import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { CoreConfig } from "./types.js";
import { resolveFortivoiceAccount } from "./accounts.js";

describe("fortivoice accounts", () => {
  it("uses account phone before shared phone", () => {
    const cfg: CoreConfig = {
      channels: {
        fortivoice: {
          url: "wss://voice.example/ws",
          phone: "+14155550111",
          accounts: {
            [DEFAULT_ACCOUNT_ID]: {
              phone: "+14155550112",
            },
          },
        },
      },
    };

    const account = resolveFortivoiceAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
    expect(account.phone).toBe("+14155550112");
    expect(account.configured).toBe(true);
  });

  it("uses FORTIVOICE_PHONE for default account when config phone is missing", () => {
    const previousPhone = process.env.FORTIVOICE_PHONE;
    process.env.FORTIVOICE_PHONE = "2000";
    try {
      const cfg: CoreConfig = {
        channels: {
          fortivoice: {
            url: "wss://voice.example/ws",
          },
        },
      };

      const account = resolveFortivoiceAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
      expect(account.phone).toBe("2000");
      expect(account.configured).toBe(true);
    } finally {
      if (previousPhone === undefined) {
        delete process.env.FORTIVOICE_PHONE;
      } else {
        process.env.FORTIVOICE_PHONE = previousPhone;
      }
    }
  });

  it("does not use FORTIVOICE_PHONE for non-default accounts", () => {
    const previousPhone = process.env.FORTIVOICE_PHONE;
    process.env.FORTIVOICE_PHONE = "+14155550124";
    try {
      const cfg: CoreConfig = {
        channels: {
          fortivoice: {
            accounts: {
              branch: {
                url: "wss://voice-branch.example/ws",
              },
            },
          },
        },
      };

      const account = resolveFortivoiceAccount({ cfg, accountId: "branch" });
      expect(account.phone).toBeUndefined();
      expect(account.configured).toBe(false);
    } finally {
      if (previousPhone === undefined) {
        delete process.env.FORTIVOICE_PHONE;
      } else {
        process.env.FORTIVOICE_PHONE = previousPhone;
      }
    }
  });

  it("requires both url and phone to be configured", () => {
    const cfg: CoreConfig = {
      channels: {
        fortivoice: {
          phone: "+14155550125",
        },
      },
    };

    const account = resolveFortivoiceAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
    expect(account.url).toBeUndefined();
    expect(account.phone).toBe("+14155550125");
    expect(account.configured).toBe(false);
  });
});
