const { EventEmitter } = require("node:events");

// Fresh module per test so queued entries and the timestamp counter reset.
// (vi.resetModules only covers the ESM graph; these files are loaded via require.)
function loadLogger() {
	vi.resetModules();
	for (const key of Object.keys(require.cache)) {
		if (key.includes("/src/") && !key.includes("/node_modules/")) {
			delete require.cache[key];
		}
	}
	return require("../logger.js");
}

function makeRequest(overrides = {}) {
	return {
		method: "GET",
		originalUrl: "/api/order/menu",
		url: "/api/order/menu",
		path: "/api/order/menu",
		headers: {},
		...overrides,
	};
}

function makeResponse(statusCode = 200) {
	const res = new EventEmitter();
	res.statusCode = statusCode;
	res.send = (body) => {
		res.sentBody = body;
		return res;
	};
	return res;
}

function captureFetch(statusCode = 200) {
	const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: statusCode });
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function streamEntries(payload) {
	return payload.streams.flatMap((stream) =>
		stream.values.map(([timestamp, line]) => ({
			labels: stream.stream,
			timestamp,
			line: JSON.parse(line),
		})),
	);
}

function sentEntries(fetchMock) {
	return fetchMock.mock.calls.flatMap(([, options]) =>
		streamEntries(JSON.parse(options.body)),
	);
}

function runRequest(logger, { req, res, user, body, responseBody }) {
	logger.httpLogger(req, res, () => {
		if (user) {
			req.user = user;
			logger.userContext(req, res, () => {});
		}
		if (body) {
			req.body = body;
		}
		if (responseBody !== undefined) {
			res.send(responseBody);
		}
		res.emit("finish");
	});
}

describe("sanitization", () => {
	test("redacts sensitive keys, truncates strings, and handles cycles", () => {
		const logger = loadLogger();
		const circular = { email: "d@jwt.com", token: "secret-token" };
		circular.self = circular;

		const sanitized = logger.sanitize({
			email: "d@jwt.com",
			password: "hunter2",
			Authorization: "Bearer abc",
			nested: { apiKey: "glc_123", jwt: "aaa.bbb.ccc", safe: 1 },
			users: [{ secret: "s" }],
			long: "x".repeat(2_500),
			circular,
			when: new Date("2026-01-02T03:04:05.000Z"),
			big: 10n,
		});

		expect(sanitized).toMatchObject({
			email: "d@jwt.com",
			password: "[REDACTED]",
			Authorization: "[REDACTED]",
			nested: { apiKey: "[REDACTED]", jwt: "[REDACTED]", safe: 1 },
			users: [{ secret: "[REDACTED]" }],
			circular: { email: "d@jwt.com", token: "[REDACTED]", self: "[circular]" },
			when: "2026-01-02T03:04:05.000Z",
			big: "10",
		});
		expect(sanitized.long.length).toBeLessThan(2_100);
		expect(sanitized.long).toContain("[truncated]");
	});

	test("parses JSON bodies and redacts credentials in both directions", () => {
		const logger = loadLogger();

		expect(logger.sanitizeBody('{"email":"d@jwt.com","token":"abc"}')).toEqual({
			email: "d@jwt.com",
			token: "[REDACTED]",
		});
		expect(logger.sanitizeBody("not json")).toBe("not json");
		expect(logger.sanitizeBody(Buffer.from("abc"))).toBe("[binary 3 bytes]");
	});

	test("redacts credentials embedded in SQL and in bound parameters", () => {
		const logger = loadLogger();
		const hash = `$2b$10$${"a".repeat(53)}`;

		const sql = logger.sanitizeSql(
			`UPDATE user SET password='${hash}', email='d@jwt.com' WHERE id=1`,
		);
		expect(sql).toBe(
			"UPDATE user SET password='[REDACTED]', email='d@jwt.com' WHERE id=1",
		);
		expect(
			logger.sanitizeParams([hash, 7, "d@jwt.com", "a".repeat(43)]),
		).toEqual(["[REDACTED]", 7, "d@jwt.com", "[REDACTED]"]);
	});
});

describe("httpLogger", () => {
	test("logs method, path, status, auth, user, and sanitized bodies", async () => {
		const logger = loadLogger();
		const fetchMock = captureFetch();
		const req = makeRequest({
			method: "POST",
			originalUrl: "/api/auth?ref=menu",
			url: "/api/auth?ref=menu",
			headers: { authorization: "Bearer token" },
		});
		const res = makeResponse(200);
		const user = { id: 7, email: "d@jwt.com", name: "diner" };

		runRequest(logger, {
			req,
			res,
			user,
			body: { email: "d@jwt.com", password: "hunter2" },
			responseBody: { user: { id: 7 }, token: "aaa.bbb.ccc" },
		});
		await logger.flush();

		const [entry] = sentEntries(fetchMock);
		expect(entry.labels).toMatchObject({
			source: require("../config.js").logging.source,
			type: "http",
			level: "info",
		});
		expect(entry.line).toMatchObject({
			type: "http",
			level: "info",
			method: "POST",
			path: "/api/auth",
			statusCode: 200,
			hasAuthHeader: true,
			user: { id: 7, email: "d@jwt.com" },
			requestBody: { email: "d@jwt.com", password: "[REDACTED]" },
			responseBody: { user: { id: 7 }, token: "[REDACTED]" },
		});
		expect(entry.line.requestId).toEqual(expect.any(String));
		expect(entry.line.durationMs).toEqual(expect.any(Number));
		expect(entry.timestamp).toMatch(/^\d{19}$/);

		const rawBody = fetchMock.mock.calls[0][1].body;
		expect(rawBody).not.toContain("hunter2");
		expect(rawBody).not.toContain("aaa.bbb.ccc");

		vi.unstubAllGlobals();
	});

	test("uses warn and error levels for failing requests", async () => {
		const logger = loadLogger();
		const fetchMock = captureFetch();

		for (const statusCode of [404, 500]) {
			const res = makeResponse(statusCode);
			runRequest(logger, { req: makeRequest(), res, responseBody: {} });
		}
		await logger.flush();

		const entries = sentEntries(fetchMock);
		expect(entries.map((entry) => entry.labels.level).sort()).toEqual([
			"error",
			"warn",
		]);

		vi.unstubAllGlobals();
	});
});

describe("context propagation", () => {
	test("database and factory logs include the authenticated user", async () => {
		const logger = loadLogger();
		const fetchMock = captureFetch();
		const req = makeRequest({ headers: { authorization: "Bearer token" } });
		const res = makeResponse(200);
		const user = { id: 9, email: "f@jwt.com" };

		logger.httpLogger(req, res, () => {
			req.user = user;
			logger.userContext(req, res, () => {
				logger.databaseQuery({
					sql: "SELECT * FROM user WHERE email=?",
					params: ["f@jwt.com"],
					durationMs: 1.25,
					rowCount: 1,
				});
				logger.factoryRequest({
					user: req.user,
					url: "https://pizza-factory.cs329.click/api/order",
					requestBody: { diner: { email: "f@jwt.com" }, order: { id: 1 } },
					responseBody: { reportUrl: "https://report", jwt: "jwt-value" },
					statusCode: 200,
					durationMs: 42,
				});
			});
			res.emit("finish");
		});
		await logger.flush();

		const entries = sentEntries(fetchMock);
		const database = entries.find((entry) => entry.labels.type === "database");
		const factory = entries.find((entry) => entry.labels.type === "factory");
		const http = entries.find((entry) => entry.labels.type === "http");

		expect(database.line).toMatchObject({
			sql: "SELECT * FROM user WHERE email=?",
			params: ["f@jwt.com"],
			rowCount: 1,
			durationMs: 1.25,
			user: { id: 9, email: "f@jwt.com" },
			requestId: http.line.requestId,
		});
		expect(factory.line).toMatchObject({
			statusCode: 200,
			user: { id: 9, email: "f@jwt.com" },
			responseBody: { reportUrl: "https://report", jwt: "[REDACTED]" },
		});
		expect(fetchMock.mock.calls[0][1].body).not.toContain("jwt-value");

		vi.unstubAllGlobals();
	});

	test("factory failures log at error level with the exception", async () => {
		const logger = loadLogger();
		const fetchMock = captureFetch();

		logger.factoryRequest({
			user: { id: 1, email: "d@jwt.com" },
			url: "https://pizza-factory.cs329.click/api/order",
			requestBody: { order: { id: 1 } },
			durationMs: 30,
			error: new Error("factory unavailable"),
		});
		await logger.flush();

		const [entry] = sentEntries(fetchMock);
		expect(entry.labels).toMatchObject({ type: "factory", level: "error" });
		expect(entry.line.error).toMatchObject({
			name: "Error",
			message: "factory unavailable",
		});

		vi.unstubAllGlobals();
	});
});

describe("exceptions and transport", () => {
	test("logs unhandled exceptions with the stack", async () => {
		const logger = loadLogger();
		const fetchMock = captureFetch();
		const error = new Error("boom");

		logger.exception(error, { source: "test" });
		await logger.flush();

		const [entry] = sentEntries(fetchMock);
		expect(entry.labels).toMatchObject({
			type: "exception",
			level: "error",
		});
		expect(entry.line).toMatchObject({
			message: "boom",
			source: "test",
			error: { name: "Error", message: "boom" },
		});
		expect(entry.line.error.stack).toContain("boom");

		vi.unstubAllGlobals();
	});

	test("posts batches in Loki JSON format with basic auth", async () => {
		const logger = loadLogger();
		const config = require("../config.js");
		const fetchMock = captureFetch();

		logger.system("first");
		logger.system("second");
		await logger.flush();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe(config.logging.endpointUrl);
		expect(options.headers.Authorization).toBe(
			`Bearer ${config.logging.accountId}:${config.logging.apiKey}`,
		);

		const payload = JSON.parse(options.body);
		expect(payload.streams).toHaveLength(1);
		expect(payload.streams[0].stream).toEqual({
			source: config.logging.source,
			type: "system",
			level: "info",
		});
		expect(payload.streams[0].values).toHaveLength(2);
		const timestamps = payload.streams[0].values.map(
			([timestamp]) => timestamp,
		);
		expect(timestamps[0]).toMatch(/^\d{19}$/);
		expect(BigInt(timestamps[1])).toBeGreaterThan(BigInt(timestamps[0]));

		vi.unstubAllGlobals();
	});

	test("caps a batch and sends the remainder on the next flush", async () => {
		const logger = loadLogger();
		const fetchMock = captureFetch();

		for (let i = 0; i < 350; i += 1) {
			logger.system(`event ${i}`);
		}
		await logger.flush();
		await logger.flush();

		expect(sentEntries(fetchMock)).toHaveLength(350);
		expect(
			JSON.parse(fetchMock.mock.calls[0][1].body).streams[0].values,
		).toHaveLength(300);
		expect(
			JSON.parse(fetchMock.mock.calls[1][1].body).streams[0].values,
		).toHaveLength(50);

		vi.unstubAllGlobals();
	});

	test("does not throw when Grafana is unavailable", async () => {
		const logger = loadLogger();
		const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		logger.system("hello");
		await expect(logger.flush()).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("network down"),
		);

		errorSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	test("reports a rejected push without throwing", async () => {
		const logger = loadLogger();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				text: () => Promise.resolve("unauthorized"),
			}),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		logger.system("hello");
		await expect(logger.flush()).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("401"));

		errorSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	test("is a no-op when logging is not configured", async () => {
		const logger = loadLogger();
		const config = require("../config.js");
		const original = config.logging;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		config.logging = undefined;
		expect(logger.isConfigured()).toBe(false);
		expect(logger.system("ignored")).toBe(false);
		expect(logger.start()).toBeNull();
		await logger.flush();
		expect(fetchMock).not.toHaveBeenCalled();

		config.logging = original;
		vi.unstubAllGlobals();
	});

	test("start is idempotent and stop clears the timer", () => {
		const logger = loadLogger();
		vi.useFakeTimers();

		const timer = logger.start(1_000);
		expect(timer).not.toBeNull();
		expect(logger.start()).toBe(timer);

		logger.stop();
		expect(logger.start()).not.toBe(timer);

		logger.stop();
		vi.useRealTimers();
	});
});
