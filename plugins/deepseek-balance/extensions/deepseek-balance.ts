import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const STATUS_KEY = "deepseek-balance";
const PROVIDER = "deepseek";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const REFRESH_MS = 10 * 60_000;
const TARIFF_REFRESH_MS = 60_000;
const CACHE_MS = 30_000;
const TIMEOUT_MS = 8_000;

type TimeBased = NonNullable<NonNullable<ExtensionContext["model"]>["cost"]["timeBased"]>;

function currencyMark(currency: string): string {
	const code = currency.toUpperCase();
	if (code === "CNY") return "¥";
	if (code === "USD") return "$";
	return `${code} `;
}

function money(value: string | undefined, currency: string): string {
	return value === undefined || value === "" ? "-" : `${currencyMark(currency)}${value}`;
}

// Catalog windows use UTC minutes since midnight and ISO weekdays (1 = Monday).
function isPeak(timeBased: TimeBased, at: Date): boolean {
	const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
	const day = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
	return timeBased.peakWindows.some(
		window => window.weekdays.includes(day) && minute >= window.startMinute && minute < window.endMinute,
	);
}

function tariffLabel(timeBased: TimeBased): string {
	if (isPeak(timeBased, new Date())) return "峰价";
	return "谷价";
}

function tariffOf(ctx: ExtensionContext): TimeBased | undefined {
	const model = ctx.models.current();
	// An explicit flat-price override must not inherit another model's schedule.
	if (model?.provider === PROVIDER) return model.cost.timeBased;
	return ctx.models.list().find(candidate => candidate.provider === PROVIDER && candidate.cost.timeBased)?.cost.timeBased;
}

export default function (pi: ExtensionAPI) {
	const z = pi.zod;
	const BalanceResponse = z.object({
		is_available: z.boolean().optional(),
		balance_infos: z.array(z.object({
			currency: z.string(),
			total_balance: z.string(),
			granted_balance: z.string().optional(),
			topped_up_balance: z.string().optional(),
		})),
	});
	type Balance = {
		is_available?: boolean;
		balance_infos: {
			currency: string;
			total_balance: string;
			granted_balance?: string;
			topped_up_balance?: string;
		}[];
	};
	type Result =
		| { ok: true; data: Balance; source: string }
		| { ok: false; error: string; message: string };
	type Session = {
		id: string;
		ctx: ExtensionContext;
		controller: AbortController;
		timers: Parameters<ExtensionContext["clearTimer"]>[0][];
		cache?: { at: number; result: Result };
		inFlight?: Promise<Result>;
	};

	// Factory-local state: separate OMP runtimes never share credentials or timers.
	let session: Session | undefined;
	const failure = (error: string, message = error): Result => ({ ok: false, error, message });
	const cancelled = (): Result => failure("已取消", "余额查询已取消，或会话已经关闭/切换。");
	const isCurrent = (state: Session): boolean =>
		session === state && !state.controller.signal.aborted && state.ctx.sessionManager.getSessionId() === state.id;

	const stop = () => {
		if (!session) return;
		const previous = session;
		session = undefined;
		previous.controller.abort();
		for (const timer of previous.timers) previous.ctx.clearTimer(timer);
		try {
			previous.ctx.ui.setStatus(STATUS_KEY, "");
		} catch {
			pi.logger.debug("deepseek-balance: 无法清除状态栏");
		}
	};

	const getSession = (ctx: ExtensionContext): Session => {
		const id = ctx.sessionManager.getSessionId();
		if (!session || session.id !== id) {
			stop();
			session = { id, ctx, controller: new AbortController(), timers: [] };
		}
		session.ctx = ctx;
		return session;
	};

	const render = (state: Session) => {
		if (!isCurrent(state)) return;
		try {
			const result = state.cache?.result;
			const parts: string[] = [];
			if (!result) parts.push("DS 余额…");
			else if (!result.ok) parts.push(`DS 余额失败:${result.error}`);
			else {
				parts.push(result.data.balance_infos.length
					? `DS ${result.data.balance_infos.map(info => money(info.total_balance, info.currency)).join(" / ")}`
					: "DS 无余额数据");
				if (result.data.is_available === false) parts.push("余额不足");
			}
			const timeBased = tariffOf(state.ctx);
			if (timeBased) parts.push(tariffLabel(timeBased));
			state.ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
		} catch {
			// Status rendering must never turn a successful query into a failure.
			pi.logger.debug("deepseek-balance: 状态栏更新失败");
		}
	};

	const query = async (state: Session): Promise<Result> => {
		const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
		let credential: string | undefined;
		let source: string;
		try {
			credential = process.env.DEEPSEEK_API_KEY?.trim();
			source = credential ? "DEEPSEEK_API_KEY" : "当前会话 DeepSeek 凭据";
			if (!credential) {
				credential = (await state.ctx.modelRegistry.getApiKeyForProvider(PROVIDER, state.id, {
					baseUrl: "https://api.deepseek.com",
					signal,
				}))?.trim();
			}
		} catch {
			if (state.controller.signal.aborted) return cancelled();
			if (signal.aborted) return failure("请求超时", "DeepSeek 凭据读取超时，请稍后重试。");
			return failure("凭据读取失败", "无法读取当前会话的 DeepSeek 凭据，请检查 /login deepseek 或 DEEPSEEK_API_KEY。");
		}
		if (signal.aborted) return state.controller.signal.aborted ? cancelled() : failure("请求超时");
		if (!credential) return failure("无凭据", "未找到 DeepSeek 凭据，请设置 DEEPSEEK_API_KEY 或执行 /login deepseek。");

		try {
			const response = await fetch(BALANCE_URL, {
				method: "GET",
				headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
				signal,
				redirect: "error",
			});
			if (!response.ok) {
				if (response.status === 401 || response.status === 403) {
					return failure("凭据被拒绝", `DeepSeek 拒绝凭据（HTTP ${response.status}），请更新 API Key 后使用 --force 刷新。`);
				}
				if (response.status === 429) return failure("请求限流", "DeepSeek 请求限流（HTTP 429），请稍后重试。");
				return failure(`HTTP ${response.status}`, `DeepSeek 余额查询失败（HTTP ${response.status}）。`);
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				if (state.controller.signal.aborted) return cancelled();
				if (signal.aborted) return failure("请求超时", "DeepSeek 余额查询超时，请稍后重试。");
				return failure("响应格式无效", "DeepSeek 返回的余额响应不是有效 JSON。");
			}
			const parsed = BalanceResponse.safeParse(payload);
			if (!parsed.success) return failure("响应格式无效", "DeepSeek 余额响应字段不符合预期，未显示旧余额。");
			return { ok: true, data: parsed.data, source };
		} catch {
			if (state.controller.signal.aborted) return cancelled();
			if (signal.aborted) return failure("请求超时", "DeepSeek 余额查询超时，请稍后重试。");
			// Never echo credentials, arbitrary response bodies, or resolver errors.
			return failure("网络请求失败", "无法连接 DeepSeek 余额接口，请检查网络后重试。");
		}
	};

	const refresh = async (state: Session, force = false): Promise<Result> => {
		if (!isCurrent(state)) return cancelled();
		// Even --force joins an existing query; every caller waits for its result.
		if (!state.inFlight && (force || !state.cache || Date.now() - state.cache.at >= CACHE_MS)) {
			state.inFlight = query(state).then(result => {
				if (isCurrent(state)) state.cache = { at: Date.now(), result };
				return result;
			}).finally(() => { state.inFlight = undefined; });
		}
		const result = state.inFlight ? await state.inFlight : state.cache!.result;
		if (!isCurrent(state)) return cancelled();
		render(state);
		return result;
	};

	const waitForResult = async (pending: Promise<Result>, signal?: AbortSignal): Promise<Result> => {
		if (!signal) return pending;
		if (signal.aborted) return cancelled();
		const { promise: aborted, resolve } = Promise.withResolvers<Result>();
		const onAbort = () => resolve(cancelled());
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			// Cancelling one tool caller must not cancel a query shared with the UI.
			return await Promise.race([pending, aborted]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	};

	const detailText = (result: Result, ctx: ExtensionContext): string => {
		if (!result.ok) return `DeepSeek 余额查询失败：${result.message}`;
		const lines = [`DeepSeek 余额${result.data.is_available === false ? "（余额不足，API 调用可能被拒绝）" : ""}`];
		if (!result.data.balance_infos.length) lines.push("接口未返回余额数据。");
		for (const info of result.data.balance_infos) {
			lines.push(`${info.currency} 总额 ${money(info.total_balance, info.currency)}`
				+ `（充值 ${money(info.topped_up_balance, info.currency)} / 赠送 ${money(info.granted_balance, info.currency)}）`);
		}
		lines.push(`来源：${result.source}`);
		const timeBased = tariffOf(ctx);
		if (timeBased) lines.push(`DeepSeek 目录计费提示：${tariffLabel(timeBased)}（仅供参考，以服务商实际计费为准）`);
		return lines.join("\n");
	};

	pi.setLabel("DeepSeek Balance");
	pi.registerCommand("ds-balance", {
		description: "查询 DeepSeek 余额明细与目录峰谷提示（--force 或 -f 忽略缓存）",
		handler: async (args, ctx) => {
			const state = getSession(ctx);
			const force = args.trim().split(/\s+/).some(arg => arg === "--force" || arg === "-f");
			const result = await refresh(state, force);
			if (isCurrent(state)) ctx.ui.notify(detailText(result, ctx), result.ok ? "info" : "warning");
		},
	});
	pi.registerTool({
		name: "deepseek_balance",
		label: "DeepSeek Balance",
		description: "查询当前会话 DeepSeek API 账户总余额、充值余额和赠送余额。只读；默认使用 30 秒缓存。",
		parameters: z.object({ force: z.boolean().optional().describe("忽略 30 秒缓存；已有查询进行时等待同一次查询") }),
		approval: "read",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = signal?.aborted ? cancelled()
				: await waitForResult(refresh(getSession(ctx), params.force ?? false), signal);
			return {
				content: [{ type: "text", text: detailText(result, ctx) }],
				details: result.ok
					? { ok: true, isAvailable: result.data.is_available, balances: result.data.balance_infos, source: result.source }
					: { ok: false, error: result.error, message: result.message },
			};
		},
	});

	const start = (_event: unknown, ctx: ExtensionContext) => {
		stop();
		const state = getSession(ctx);
		render(state);
		state.timers.push(
			ctx.setTimeout(async () => { await refresh(state); }, 50),
			ctx.setInterval(async () => { await refresh(state); }, REFRESH_MS),
			ctx.setInterval(() => { render(state); }, TARIFF_REFRESH_MS),
		);
	};
	pi.on("session_start", start);
	pi.on("session_switch", start);
	pi.on("session_branch", start);
	pi.on("session_shutdown", (_event, ctx) => {
		if (session?.id === ctx.sessionManager.getSessionId()) stop();
	});
}
