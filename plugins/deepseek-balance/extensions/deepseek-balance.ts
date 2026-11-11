import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const STATUS_KEY = "deepseek-balance";
const PROVIDER = "deepseek";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const REFRESH_MS = 60_000;

type PeakWindow = { startMinute: number; endMinute: number; weekdays: number[] };
type TimeBased = { offPeakMultiplier: number; peakWindows: PeakWindow[] };
type ModelLike = { provider?: string; cost?: { timeBased?: TimeBased } };
type StatusContext = {
	model?: ModelLike;
	models?: { list?: () => ModelLike[] };
	sessionManager?: { getSessionId?: () => string };
	ui: { setStatus: (key: string, text?: string) => void };
};

function currencyMark(currency: string): string {
	if (currency === "CNY") return "¥";
	if (currency === "USD") return "$";
	return `${currency} `;
}

// DeepSeek's peak windows are UTC minutes since midnight with ISO weekdays (1 = Monday).
function isPeak(timeBased: TimeBased, at: Date): boolean {
	const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
	const day = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
	return timeBased.peakWindows.some(
		window => window.weekdays.includes(day) && minute >= window.startMinute && minute < window.endMinute,
	);
}

function tariffLabel(timeBased: TimeBased): string {
	if (isPeak(timeBased, new Date())) return "峰价";
	const discount = Math.round((1 - timeBased.offPeakMultiplier) * 100);
	return `谷价-${discount}%`;
}

export default function (pi: ExtensionAPI) {
	const z = pi.zod;
	const BalanceResponse = z.object({
		balance_infos: z.array(z.object({ currency: z.string(), total_balance: z.string() })),
	});

	const timers = new Map<string, unknown>();
	let apiKey: string | undefined;
	let balanceText: string | undefined;
	let balanceError: string | undefined;
	let fetching = false;

	const sessionKey = (ctx: StatusContext): string => {
		try {
			return ctx.sessionManager?.getSessionId?.() ?? "default";
		} catch {
			return "default";
		}
	};

	const resolveApiKey = async (): Promise<string | undefined> => {
		if (apiKey) return apiKey;
		const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
		if (fromEnv) {
			apiKey = fromEnv;
			return apiKey;
		}
		try {
			const result = await pi.exec("omp", ["token", PROVIDER], { timeout: 10_000 });
			const stored = result.code === 0 ? result.stdout.trim() : "";
			if (stored.startsWith("sk-")) apiKey = stored;
		} catch {
			// Stored credential unavailable; the status segment reports the failure.
		}
		return apiKey;
	};

	// The tariff line is a DeepSeek reminder: while another provider is active, read the
	// schedule from a DeepSeek model still in the registry. A deepseek model without a
	// schedule (flat-price override) shows no tariff rather than a wrong one.
	const tariffOf = (ctx: StatusContext): TimeBased | undefined => {
		if (ctx.model?.provider === PROVIDER) return ctx.model.cost?.timeBased;
		try {
			return ctx.models?.list?.().find(model => model.provider === PROVIDER && model.cost?.timeBased)?.cost?.timeBased;
		} catch {
			return undefined;
		}
	};

	const render = (ctx: StatusContext) => {
		const parts: string[] = [];
		if (balanceText) parts.push(`DS ${balanceText}`);
		else if (balanceError) parts.push(`DS 余额失败:${balanceError}`);
		else parts.push("DS 余额…");

		const timeBased = tariffOf(ctx);
		if (timeBased) parts.push(tariffLabel(timeBased));

		ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
	};

	const refreshBalance = async (ctx: StatusContext) => {
		if (fetching) return;
		fetching = true;
		try {
			const credential = await resolveApiKey();
			if (!credential) {
				balanceText = undefined;
				balanceError = "无凭证";
				return;
			}
			const response = await fetch(BALANCE_URL, {
				headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
				signal: AbortSignal.timeout(8_000),
			});
			if (!response.ok) {
				balanceText = undefined;
				balanceError = `HTTP ${response.status}`;
				return;
			}
			const parsed = BalanceResponse.parse(await response.json());
			balanceText = parsed.balance_infos.map(info => `${currencyMark(info.currency)}${info.total_balance}`).join(" ");
			balanceError = undefined;
		} catch (error) {
			balanceText = undefined;
			balanceError = error instanceof Error ? error.name : "错误";
		} finally {
			fetching = false;
			render(ctx);
		}
	};

	pi.setLabel("DeepSeek Balance");

	pi.registerCommand("ds-balance", {
		description: "Refresh DeepSeek balance and the current tariff",
		handler: async (_args, ctx) => {
			await refreshBalance(ctx);
			const timeBased = tariffOf(ctx);
			ctx.ui.notify(
				[
					`余额: ${balanceText ?? balanceError ?? "未知"}`,
					`计费: ${timeBased ? tariffLabel(timeBased) : "无峰谷价"}`,
				].join("\n"),
				balanceError ? "warning" : "info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const key = sessionKey(ctx);
		await refreshBalance(ctx);
		render(ctx);
		const timer = ctx.setInterval(() => {
			void refreshBalance(ctx);
		}, REFRESH_MS);
		timers.set(key, timer);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const key = sessionKey(ctx);
		const timer = timers.get(key);
		if (timer !== undefined) ctx.clearTimer(timer);
		timers.delete(key);
	});
}
