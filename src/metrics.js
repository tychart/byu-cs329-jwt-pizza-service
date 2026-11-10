const os = require("os");
const config = require("./config.js");

const REPORT_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// In-memory metric state
//
// Counters are cumulative for the life of the process (monotonic sums), so
// Grafana can use rate()/increase() on them. Gauges are sampled at report time.
// ---------------------------------------------------------------------------

// `${method} ${endpoint}` -> count / total milliseconds
const requestCounts = new Map();
const requestLatencies = new Map();

const authAttempts = { success: 0, failure: 0 };

// `orders` counts factory calls (the latency denominator); `sold` and `failed`
// count pizzas, so a multi-pizza order contributes more than one.
const pizzaPurchases = {
	orders: 0,
	sold: 0,
	failed: 0,
	revenue: 0,
	latencyMs: 0,
};

// Users seen since the previous report. Reset after each report so the
// `active_users` gauge describes the current reporting window.
const activeUserIds = new Set();

// CPU usage is the busy percentage of the time between two samples.
let lastCpuTimes = readCpuTimes();

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

// Express middleware that records request count and latency for every request.
// Reads `req.user`, so it must be registered before the routes (the value is
// only read once the response finishes).
function requestTracker(req, res, next) {
	const start = process.hrtime.bigint();

	res.on("finish", () => {
		const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
		const key = `${req.method} ${endpointOf(req)}`;

		requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
		requestLatencies.set(key, (requestLatencies.get(key) ?? 0) + latencyMs);

		recordActiveUser(req.user);
	});

	next();
}

// Express middleware for login (PUT) and registration (POST) attempts.
// Logout is not an authentication attempt, so it is ignored.
function authTracker(req, res, next) {
	if (req.method !== "PUT" && req.method !== "POST") {
		return next();
	}

	res.on("finish", () => {
		if (res.statusCode < 400) {
			authAttempts.success += 1;
		} else {
			authAttempts.failure += 1;
		}
	});

	next();
}

// Called by the order router after the Pizza Factory responds. Latency is one
// factory round trip per order, so it is summed once and divided by `orders`
// later; `pizzaCount` is how many pizzas that order contained.
function pizzaPurchase(success, latencyMs, price, pizzaCount = 1) {
	const pizzas = pizzaCount ?? 1;

	pizzaPurchases.orders += 1;
	pizzaPurchases.latencyMs += latencyMs;

	if (success) {
		pizzaPurchases.sold += pizzas;
		pizzaPurchases.revenue += price || 0;
	} else {
		pizzaPurchases.failed += pizzas;
	}
}

function recordActiveUser(user) {
	if (user?.id !== undefined && user?.id !== null) {
		activeUserIds.add(user.id);
	}
}

// Use the route pattern rather than the concrete URL so /api/order/1 and
// /api/order/2 do not become separate Prometheus series.
function endpointOf(req) {
	const base = req.baseUrl ?? "";
	const routePath = req.route?.path;
	const endpoint = routePath ? `${base}${routePath}` : req.path;
	return endpoint.replace(/\/$/, "") || "/";
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

// Builds the OTLP metrics array. Exported so it can be verified in tests.
function buildMetrics() {
	const metrics = [];

	const requestPoints = [];
	const latencyPoints = [];
	for (const [key, count] of requestCounts) {
		const attributes = keyToAttributes(key);
		requestPoints.push(createDataPoint(count, attributes));
		latencyPoints.push(
			createDataPoint(requestLatencies.get(key) ?? 0, attributes, "asDouble"),
		);
	}
	if (requestPoints.length > 0) {
		metrics.push(createSum("http_requests", "1", requestPoints));
		metrics.push(createSum("http_request_duration", "ms", latencyPoints));
	}

	metrics.push(
		createSum("auth_attempts", "1", [
			createDataPoint(authAttempts.success, { status: "success" }),
			createDataPoint(authAttempts.failure, { status: "failure" }),
		]),
	);

	metrics.push(
		createSum("pizza_orders", "1", [createDataPoint(pizzaPurchases.orders)]),
		createSum("pizzas_sold", "1", [createDataPoint(pizzaPurchases.sold)]),
		createSum("pizza_creation_failures", "1", [
			createDataPoint(pizzaPurchases.failed),
		]),
		createSum("pizza_revenue", "1", [
			createDataPoint(pizzaPurchases.revenue, {}, "asDouble"),
		]),
		createSum("pizza_creation_duration", "ms", [
			createDataPoint(pizzaPurchases.latencyMs, {}, "asDouble"),
		]),
	);

	metrics.push(
		createGauge("active_users", "1", [createDataPoint(activeUserIds.size)]),
		createGauge("cpu_usage", "%", [
			createDataPoint(sampleCpuUsage(), {}, "asDouble"),
		]),
		createGauge("memory_usage", "%", [
			createDataPoint(sampleMemoryUsage(), {}, "asDouble"),
		]),
	);

	return metrics;
}

function buildPayload() {
	const source = config.metrics.source; // This should be "jwt-pizza-service";

	return {
		resourceMetrics: [
			{
				resource: {
					attributes: [{ key: "service.name", value: { stringValue: source } }],
				},
				scopeMetrics: [
					{
						scope: { name: "jwt-pizza-service" },
						metrics: buildMetrics(),
					},
				],
			},
		],
	};
}

// Sends the current metrics to Grafana and starts a fresh active-user window.
async function reportMetrics() {
	try {
		const payload = buildPayload();
		activeUserIds.clear();

		const response = await fetch(config.metrics.endpointUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Grafana responded ${response.status}: ${body}`);
		}
	} catch (error) {
		console.error("Error sending metrics", error);
	}
}

// Starts periodic reporting. Called from index.js (not service.js) so tests
// that import the Express app don't send metrics.
function startReporting(period = REPORT_INTERVAL_MS) {
	if (!config.metrics?.endpointUrl) {
		console.log("Metrics reporting disabled: config.metrics is not configured");
		return null;
	}

	const timer = setInterval(reportMetrics, period);
	// Do not keep the process (or a test run) alive just to send metrics.
	timer.unref?.();
	return timer;
}

// ---------------------------------------------------------------------------
// OTLP JSON helpers
// ---------------------------------------------------------------------------

function createSum(name, unit, dataPoints) {
	return {
		name,
		unit,
		sum: {
			dataPoints,
			aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE",
			isMonotonic: true,
		},
	};
}

function createGauge(name, unit, dataPoints) {
	return { name, unit, gauge: { dataPoints } };
}

function createDataPoint(value, attributes = {}, valueType = "asInt") {
	const dataPoint = {
		[valueType]: value,
		timeUnixNano: nanoNow(),
		attributes: [
			{
				key: "source",
				value: { stringValue: config.metrics?.source ?? "unknown" },
			},
		],
	};

	for (const [key, attributeValue] of Object.entries(attributes)) {
		dataPoint.attributes.push({
			key,
			value: { stringValue: String(attributeValue) },
		});
	}

	return dataPoint;
}

function keyToAttributes(key) {
	const separator = key.indexOf(" ");
	return {
		method: key.slice(0, separator),
		endpoint: key.slice(separator + 1),
	};
}

// OTLP JSON encodes uint64 values as strings to avoid precision loss.
function nanoNow() {
	return (BigInt(Date.now()) * 1_000_000n).toString();
}

// ---------------------------------------------------------------------------
// System metrics
// ---------------------------------------------------------------------------

function readCpuTimes() {
	let idle = 0;
	let total = 0;

	for (const cpu of os.cpus()) {
		const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
		idle += cpuIdle;
		total += user + nice + sys + cpuIdle + irq;
	}

	return { idle, total };
}

// Percentage of CPU time that was busy since the previous call.
function sampleCpuUsage() {
	const now = readCpuTimes();
	const idleDelta = now.idle - lastCpuTimes.idle;
	const totalDelta = now.total - lastCpuTimes.total;
	lastCpuTimes = now;

	if (totalDelta <= 0) {
		return 0;
	}

	const usage = (1 - idleDelta / totalDelta) * 100;
	return Number(Math.min(100, Math.max(0, usage)).toFixed(2));
}

function sampleMemoryUsage() {
	const total = os.totalmem();
	const used = total - os.freemem();
	return Number(((used / total) * 100).toFixed(2));
}

module.exports = {
	requestTracker,
	authTracker,
	pizzaPurchase,
	recordActiveUser,
	reportMetrics,
	startReporting,
	buildMetrics,
	buildPayload,
};
