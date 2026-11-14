import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { z } from "@oh-my-pi/omptype/zod";

const source = stripTypeScriptTypes(await readFile(new URL("../extensions/deepseek-balance.ts", import.meta.url), "utf8"));
const { default: install } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const sample = {
	is_available: true,
	balance_infos: [{ currency: "CNY", total_balance: "12.3400", topped_up_balance: "10.0000", granted_balance: "2.3400" }],
};

function setup(t, { envKey = "sk-test-environment", registryKey = "sk-test-registry" } = {}) {
	const savedKey = process.env.DEEPSEEK_API_KEY;
	if (envKey === null) delete process.env.DEEPSEEK_API_KEY;
	else process.env.DEEPSEEK_API_KEY = envKey;
	t.after(() => {
		if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = savedKey;
	});
	const commands = new Map(), events = new Map(), timers = new Map();
	const statuses = [], notices = [], requests = [], resolutions = [], logs = [];
	let tool, timerId = 0;
	const state = {
		sessionId: "session-one", registryKey, throwStatus: false, model: undefined, models: [],
		respond: async () => Response.json(sample),
	};
	t.mock.method(globalThis, "fetch", async (url, options) => {
		assert.equal(url, "https://api.deepseek.com/user/balance", "Tests must never reach another endpoint");
		requests.push({ url, ...options });
		return state.respond(options);
	});
	const ctx = {
		sessionManager: { getSessionId: () => state.sessionId },
		models: { current: () => state.model, list: () => state.models },
		modelRegistry: { getApiKeyForProvider: async (...args) => { resolutions.push(args); return state.registryKey; } },
		ui: {
			setStatus: (_key, text) => { if (state.throwStatus) throw new Error("UI unavailable"); statuses.push(text); },
			notify: (text, level) => notices.push({ text, level }),
		},
		setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms, once: true }); return id; },
		setInterval: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms, once: false }); return id; },
		clearTimer: id => timers.delete(id),
	};
	install({
		zod: z, setLabel() {}, logger: { debug: message => logs.push(message) },
		registerCommand: (name, command) => commands.set(name, command),
		registerTool: definition => { tool = definition; },
		on: (event, callback) => events.set(event, callback),
	});
	return {
		state, ctx, commands, events, timers, statuses, notices, requests, resolutions, logs,
		command: (args = "") => commands.get("ds-balance").handler(args, ctx),
		query: (params = {}, signal) => tool.execute("test-call", tool.parameters.parse(params), signal, undefined, ctx),
		emit: event => events.get(event)({}, ctx),
		async runTimer(ms) {
			const entry = [...timers].find(([, timer]) => timer.ms === ms);
			assert.ok(entry, `Expected managed timer at ${ms}ms`);
			if (entry[1].once) timers.delete(entry[0]);
			await entry[1].callback();
		},
	};
}

test("details preserve monetary precision and expose unavailable accounts", async t => {
	const h = setup(t);
	h.state.respond = async () => Response.json({ ...sample, is_available: false });
	const result = await h.query();
	assert.equal(result.details.isAvailable, false);
	assert.deepEqual(result.details.balances, sample.balance_infos);
	assert.match(result.content[0].text, /充值 ¥10\.0000 \/ 赠送 ¥2\.3400/);
	assert.match(h.statuses.at(-1), /DS ¥12\.3400 · 余额不足/);
});

test("command and tool share a 30-second cache, with both force flags supported", async t => {
	let now = 1_000;
	t.mock.method(Date, "now", () => now);
	const h = setup(t);
	await h.command();
	await h.query();
	assert.equal(h.requests.length, 1);
	now += 30_000;
	await h.query();
	assert.equal(h.requests.length, 2);
	await h.command("-f");
	await h.command("--force");
	await h.query({ force: true });
	assert.equal(h.requests.length, 5);
});

test("rotated environment keys are used on the next forced request", async t => {
	const h = setup(t);
	await h.command();
	process.env.DEEPSEEK_API_KEY = "sk-test-rotated";
	await h.command("--force");
	assert.equal(h.requests[0].headers.Authorization, "Bearer sk-test-environment");
	assert.equal(h.requests[1].headers.Authorization, "Bearer sk-test-rotated");
	assert.equal(h.resolutions.length, 0);
});

test("credentials resolve from the calling session again after rotation", async t => {
	const h = setup(t, { envKey: null });
	await h.query();
	h.state.registryKey = "sk-test-new-registry-key";
	await h.query({ force: true });
	assert.equal(h.resolutions[0][0], "deepseek");
	assert.equal(h.resolutions[0][1], "session-one");
	assert.equal(h.resolutions[1][1], "session-one");
	assert.equal(h.requests[1].headers.Authorization, `Bearer ${h.state.registryKey}`);
});

test("missing credentials give recovery instructions without making a request", async t => {
	const h = setup(t, { envKey: null, registryKey: null });
	const result = await h.query();
	assert.equal(result.details.ok, false);
	assert.match(result.content[0].text, /DEEPSEEK_API_KEY.*\/login deepseek/);
	assert.equal(h.requests.length, 0);
});

test("simultaneous commands and tools wait for one shared response", async t => {
	const h = setup(t);
	const gate = Promise.withResolvers();
	h.state.respond = () => gate.promise;
	const first = h.command("--force");
	const second = h.command("--force");
	const third = h.query({ force: true });
	assert.equal(h.requests.length, 1);
	assert.equal(h.notices.length, 0, "No caller should report an unknown balance while the query is pending");
	gate.resolve(Response.json(sample));
	const [, , result] = await Promise.all([first, second, third]);
	assert.equal(result.details.ok, true);
	for (const notice of h.notices) assert.match(notice.text, /12\.3400/);
});

test("malformed response fields replace an earlier balance with an error", async t => {
	const h = setup(t);
	await h.command();
	h.state.respond = async () => Response.json({ balance_infos: [{ currency: "CNY", total_balance: 999 }] });
	const result = await h.query({ force: true });
	assert.equal(result.details.ok, false);
	assert.match(h.statuses.at(-1), /响应格式无效/);
	assert.doesNotMatch(h.statuses.at(-1), /12\.3400|999/);
});

test("invalid JSON is reported rather than treated as an empty balance", async t => {
	const h = setup(t);
	h.state.respond = async () => new Response("not-json");
	const result = await h.query();
	assert.equal(result.details.ok, false);
	assert.match(result.content[0].text, /不是有效 JSON/);
});

test("HTTP and network errors never expose response bodies or credential text", async t => {
	const h = setup(t);
	for (const status of [401, 403, 429, 502]) {
		h.state.respond = async () => new Response("sk-secret-response-body", { status });
		const result = await h.query({ force: true });
		assert.equal(result.details.ok, false);
		assert.match(result.content[0].text, new RegExp(`HTTP ${status}`));
		assert.doesNotMatch(JSON.stringify(result), /sk-secret/);
	}
	h.state.respond = async () => { throw new Error("network failed with sk-secret-key"); };
	const result = await h.query({ force: true });
	assert.equal(result.details.error, "网络请求失败");
	assert.doesNotMatch(JSON.stringify(result), /sk-secret/);
});

test("empty and partial balance records remain useful without inventing amounts", async t => {
	const h = setup(t);
	h.state.respond = async () => Response.json({ balance_infos: [] });
	await h.command();
	assert.equal(h.statuses.at(-1), "DS 无余额数据");
	h.state.respond = async () => Response.json({ balance_infos: [{ currency: "usd", total_balance: "0.10" }] });
	const result = await h.query({ force: true });
	assert.match(result.content[0].text, /总额 \$0\.10（充值 - \/ 赠送 -）/);
});

test("status UI failures do not discard a successful query", async t => {
	const h = setup(t);
	h.state.throwStatus = true;
	await h.command();
	const result = await h.query();
	assert.equal(result.details.ok, true);
	assert.match(h.notices[0].text, /12\.3400/);
});

test("repeated starts are nonblocking and shutdown clears every timer", async t => {
	const h = setup(t);
	await h.emit("session_start");
	assert.equal(h.requests.length, 0);
	await h.emit("session_start");
	await h.runTimer(50);
	assert.equal(h.requests.length, 1);
	await h.emit("session_shutdown");
	assert.equal(h.timers.size, 0);
	assert.equal(h.statuses.at(-1), "");
});

test("a late response after shutdown cannot restore the status or notify", async t => {
	const h = setup(t);
	const gate = Promise.withResolvers();
	h.state.respond = () => gate.promise;
	await h.emit("session_start");
	const pending = h.command();
	await h.emit("session_shutdown");
	assert.equal(h.requests[0].signal.aborted, true);
	const statusesAfterShutdown = h.statuses.length;
	gate.resolve(Response.json(sample));
	await pending;
	assert.equal(h.statuses.length, statusesAfterShutdown);
	assert.equal(h.notices.length, 0);
	assert.equal(h.timers.size, 0);
});

test("session switches discard old cache and ignore old in-flight results", async t => {
	const h = setup(t);
	const gate = Promise.withResolvers();
	h.state.respond = () => gate.promise;
	await h.emit("session_start");
	const oldQuery = h.query();
	h.state.sessionId = "session-two";
	await h.emit("session_switch");
	h.state.respond = async () => Response.json({ balance_infos: [{ currency: "CNY", total_balance: "99.00" }] });
	const current = await h.query();
	gate.resolve(Response.json(sample));
	const previous = await oldQuery;
	assert.equal(current.details.balances[0].total_balance, "99.00");
	assert.equal(previous.details.ok, false);
	assert.match(h.statuses.at(-1), /99\.00/);
	await h.emit("session_shutdown");
	assert.equal(h.timers.size, 0);
});

test("cancelling one tool does not cancel a shared command query", async t => {
	const h = setup(t);
	const gate = Promise.withResolvers();
	h.state.respond = () => gate.promise;
	const pendingCommand = h.command();
	const controller = new AbortController();
	const pendingTool = h.query({}, controller.signal);
	controller.abort();
	const result = await pendingTool;
	assert.equal(result.details.ok, false);
	assert.equal(h.requests[0].signal.aborted, false);
	gate.resolve(Response.json(sample));
	await pendingCommand;
	assert.match(h.notices[0].text, /12\.3400/);
	assert.equal(h.requests.length, 1);
});

test("an already-cancelled tool starts no query", async t => {
	const h = setup(t);
	const result = await h.query({}, AbortSignal.abort());
	assert.equal(result.details.ok, false);
	assert.equal(h.requests.length, 0);
});

test("tariff ticks follow UTC boundaries without extra balance requests", async t => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-16T00:59:00Z") });
	const h = setup(t);
	const timeBased = { offPeakMultiplier: 0.5, peakWindows: [{ weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 }] };
	h.state.models = [{ provider: "deepseek", cost: { timeBased } }];
	await h.emit("session_start");
	await h.runTimer(50);
	assert.equal(h.statuses.at(-1), "DS ¥12.3400 · 谷价");
	await h.command();
	assert.match(h.notices.at(-1).text, /目录计费提示：谷价（/);
	t.mock.timers.tick(60_000);
	await h.runTimer(60_000);
	assert.match(h.statuses.at(-1), /峰价/);
	assert.equal(h.requests.length, 1);
	// A flat-priced current DeepSeek model must not borrow another model's tariff.
	h.state.model = { provider: "deepseek", cost: {} };
	await h.runTimer(60_000);
	assert.doesNotMatch(h.statuses.at(-1), /峰价|谷价/);
	await h.emit("session_shutdown");
});
