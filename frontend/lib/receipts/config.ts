/**
 * Receipt scanner configuration (fork: con-chad/smart-garage, D-012/D-042).
 * Everything comes from env so an install without these variables behaves
 * exactly like upstream:
 *
 *   RECEIPT_SCANNER_ENABLED=true        off by default
 *   ANTHROPIC_API_KEY=sk-ant-...        required when enabled; never logged or sent to clients
 *   RECEIPT_SCANNER_MODEL=...           vision-capable Claude model id
 *   RECEIPT_SCANNER_DAILY_LIMIT=30      scans per user per UTC day
 *   RECEIPT_SCANNER_EFFORT=low          low | medium | high | xhigh | max | off
 */

/**
 * Default model. Checked against the Claude models overview on 2026-10-22:
 * Claude Sonnet 5.5 (`claude-sonnet-5-5`) is the current Sonnet, supports
 * image input, and is fast. A receipt photo plus the short JSON answer is
 * well under a cent per scan. `claude-haiku-5-5` is the cheaper alternative
 * for operators who prefer it.
 */
export const DEFAULT_RECEIPT_SCANNER_MODEL = "claude-sonnet-5-5";
export const DEFAULT_RECEIPT_SCANNER_DAILY_LIMIT = 30;
export const DEFAULT_RECEIPT_SCANNER_EFFORT = "low";

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export type ReceiptScannerConfig = {
  /** True only when the flag is on *and* an API key is present. */
  enabled: boolean;
  apiKey: string | null;
  model: string;
  dailyLimit: number;
  /** `output_config.effort` for the model call; null leaves the model's default. */
  effort: string | null;
};

type Env = Record<string, string | undefined>;

const warned = globalThis as unknown as { receiptScannerKeyWarned?: boolean };

export function receiptScannerConfig(env: Env = process.env): ReceiptScannerConfig {
  const flag = /^(1|true|yes|on)$/i.test((env.RECEIPT_SCANNER_ENABLED ?? "").trim());
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || null;

  if (flag && !apiKey && !warned.receiptScannerKeyWarned) {
    warned.receiptScannerKeyWarned = true;
    console.warn("[receipt-scanner] RECEIPT_SCANNER_ENABLED is set but ANTHROPIC_API_KEY is missing; the scanner stays off");
  }

  const limitRaw = Number.parseInt((env.RECEIPT_SCANNER_DAILY_LIMIT ?? "").trim(), 10);
  const dailyLimit = Number.isFinite(limitRaw) && limitRaw >= 1 ? limitRaw : DEFAULT_RECEIPT_SCANNER_DAILY_LIMIT;

  const effortRaw = (env.RECEIPT_SCANNER_EFFORT ?? DEFAULT_RECEIPT_SCANNER_EFFORT).trim().toLowerCase();
  const effort = EFFORT_LEVELS.has(effortRaw)
    ? effortRaw
    : effortRaw === "off" || effortRaw === "none" || effortRaw === ""
      ? null
      : DEFAULT_RECEIPT_SCANNER_EFFORT;

  return {
    enabled: flag && apiKey !== null,
    apiKey,
    model: env.RECEIPT_SCANNER_MODEL?.trim() || DEFAULT_RECEIPT_SCANNER_MODEL,
    dailyLimit,
    effort,
  };
}
