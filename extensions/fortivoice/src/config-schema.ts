import { MarkdownConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const wsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "ws:" || parsed.protocol === "wss:";
    } catch {
      return false;
    }
  }, "FortiVoice URL must use ws:// or wss://");

const phoneSchema = z.string().min(1, "FortiVoice phone must not be empty");

export const FortivoiceAccountConfigSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().optional(),
  phone: phoneSchema.optional(),
  url: wsUrlSchema.optional(),
  reconnectDelayMs: z.number().int().min(250).max(60_000).optional(),
  helloWorldOnStart: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
});

export const FortivoiceConfigSchema = z.object({
  enabled: z.boolean().optional(),
  defaultAccount: z.string().optional(),
  name: z.string().optional(),
  phone: phoneSchema.optional(),
  url: wsUrlSchema.optional(),
  reconnectDelayMs: z.number().int().min(250).max(60_000).optional(),
  helloWorldOnStart: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  accounts: z.record(z.string(), FortivoiceAccountConfigSchema).optional(),
});

export type FortivoiceAccountConfig = z.infer<typeof FortivoiceAccountConfigSchema>;
export type FortivoiceConfig = z.infer<typeof FortivoiceConfigSchema>;
