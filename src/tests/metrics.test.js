const { EventEmitter } = require("node:events");

// Fresh module per test so the in-memory counters do not leak between tests.
// (vi.resetModules only covers the ESM graph; these files are loaded via require.)
function loadMetrics() {
	vi.resetModules();
	for (const key of Object.keys(require.cache)) {
		if (key.includes("/src/") && !key.includes("/node_modules/")) {
			delete require.cache[key];
		}
	}
	return require("../metrics.js");
}

function trackRequest(metrics, request, statusCode = 200) {
	const res = new EventEmitter();
	res.statusCode = statusCode;

	const next = vi.fn();
	metrics.requestTracker(request, res, next);
	res.emit("finish");

	return next;
}

function attributesOf(dataPoint) {
	return Object.fromEntries(
		dataPoint.attributes.map(({ key, value }) => [key, value.stringValue]),
	);
}

function findMetric(metrics, name) {
	const metric = metrics.find((candidate) => candidate.name === name);
	expect(metric).toBeDefined();
	return metric;
}

describe("requestTracker", () => {
	test("counts requests and latency by method and route pattern", () => {
		const metrics = loadMetrics();
		const request = {
			method: "GET",
			path: "/api/order/menu",
			baseUrl: "/api/order",
			route: { path: "/menu" },
		};

		const next = trackRequest(metrics, request);
		trackRequest(metrics, request);
		expect(next).toHaveBeenCalledTimes(1);

		const built = metrics.buildMetrics();
		const requests = findMetric(built, "http_requests");
		expect(requests.sum.dataPoints).toHaveLength(1);
		expect(requests.sum.dataPoints[0].asInt).toBe(2);
		expect(attributesOf(requests.sum.dataPoints[0])).toMatchObject({
			method: "GET",
			endpoint: "/api/order/menu",
		});

		const latency = findMetric(built, "http_request_duration");
		expect(latency.sum.dataPoints[0].asDouble).toBeGreaterThanOrEqual(0);
	});

	test("keeps distinct methods and strips the trailing slash", () => {
		const metrics = loadMetrics();
		trackRequest(metrics, {
			method: "POST",
			path: "/api/order",
			baseUrl: "/api/order",
			route: { path: "/" },
		});
		trackRequest(metrics, { method: "GET", path: "/nope" });

		const built = metrics.buildMetrics();
		const endpoints = findMetric(built, "http_requests").sum.dataPoints.map(
			(point) => attributesOf(point),
		);

		expect(endpoints).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ method: "POST", endpoint: "/api/order" }),
				expect.objectContaining({ method: "GET", endpoint: "/nope" }),
			]),
		);
	});

	test("records active users only once per report window", async () => {
		const metrics = loadMetrics();
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetchMock);

		metrics.recordActiveUser({ id: 1 });
		metrics.recordActiveUser({ id: 1 });
		metrics.recordActiveUser({ id: 2 });
		metrics.recordActiveUser(null);

		expect(
			findMetric(metrics.buildMetrics(), "active_users").gauge.dataPoints[0]
				.asInt,
		).toBe(2);

		await metrics.reportMetrics();
		expect(
			findMetric(metrics.buildMetrics(), "active_users").gauge.dataPoints[0]
				.asInt,
		).toBe(0);

		vi.unstubAllGlobals();
	});
});

describe("authTracker", () => {
	test("separates successful and failed attempts, ignoring logout", () => {
		const metrics = loadMetrics();

		for (const [method, statusCode] of [
			["PUT", 200],
			["POST", 200],
			["PUT", 404],
			["DELETE", 200],
		]) {
			const res = new EventEmitter();
			res.statusCode = statusCode;
			metrics.authTracker({ method }, res, vi.fn());
			res.emit("finish");
		}

		const attempts = findMetric(metrics.buildMetrics(), "auth_attempts");
		expect(attempts.sum.dataPoints[0].asInt).toBe(2);
		expect(attributesOf(attempts.sum.dataPoints[0]).status).toBe("success");
		expect(attempts.sum.dataPoints[1].asInt).toBe(1);
		expect(attributesOf(attempts.sum.dataPoints[1]).status).toBe("failure");
	});
});

describe("pizzaPurchase", () => {
	test("tracks sold, failed, revenue and creation latency", () => {
		const metrics = loadMetrics();

		metrics.pizzaPurchase(true, 100, 12.5);
		metrics.pizzaPurchase(true, 200, 7.5);
		metrics.pizzaPurchase(false, 400, 0);

		const built = metrics.buildMetrics();
		expect(findMetric(built, "pizzas_sold").sum.dataPoints[0].asInt).toBe(2);
		expect(
			findMetric(built, "pizza_creation_failures").sum.dataPoints[0].asInt,
		).toBe(1);
		expect(findMetric(built, "pizza_revenue").sum.dataPoints[0].asDouble).toBe(
			20,
		);
		expect(
			findMetric(built, "pizza_creation_duration").sum.dataPoints[0].asDouble,
		).toBe(700);
	});
});

describe("reporting", () => {
	test("posts an OTLP payload to the configured Grafana endpoint", async () => {
		const metrics = loadMetrics();
		const config = require("../config.js");
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetchMock);

		metrics.pizzaPurchase(true, 50, 10);
		await metrics.reportMetrics();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe(config.metrics.endpointUrl);
		expect(options.headers.Authorization).toBe(
			`Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`,
		);

		const payload = JSON.parse(options.body);
		const messages = payload.resourceMetrics[0].scopeMetrics[0].metrics;
		expect(messages.some((metric) => metric.name === "http_requests")).toBe(
			false,
		);
		expect(findMetric(messages, "pizzas_sold").sum.dataPoints[0].asInt).toBe(1);
		expect(
			payload.resourceMetrics[0].resource.attributes[0].value.stringValue,
		).toBe(config.metrics.source);

		vi.unstubAllGlobals();
	});

	test("logs instead of throwing when Grafana rejects the payload", async () => {
		const metrics = loadMetrics();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				text: () => Promise.resolve("unauthorized"),
			}),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(metrics.reportMetrics()).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalled();

		errorSpy.mockRestore();
		vi.unstubAllGlobals();
	});
});
