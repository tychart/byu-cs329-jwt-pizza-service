const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID } = require("node:crypto");
const config = require("./config.js");

// ---------------------------------------------------------------------------
// Configuration
//
// Logs are pushed to Grafana Cloud Loki with the JSON push API:
//   POST <endpointUrl>  (e.g. https://logs-prod-042.grafana.net/loki/api/v1/push)
//   Authorization: Bearer <accountId>:<apiKey>
//   { "streams": [{ "stream": {labels}, "values": [[nsTimestamp, line]] }] }
//
// Events are buffered and sent in batches so a busy request never waits on the
// network. If logging is not configured every entry point becomes a no-op.
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 1_000;
const MAX_QUEUE_ENTRIES = 2_000;
const MAX_BATCH_ENTRIES = 300;
// Grafana Cloud rejects large pushes; keep well under the 1 MiB limit.
const MAX_BATCH_BYTES = 512 * 1_024;
const MAX_LINE_CHARS = 16_000;
const MAX_FIELD_CHARS = 2_000;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;

// Keys whose values must never reach Grafana. The response bodies this service
// returns contain `token` (login/register) and `jwt` (orders), and request
// bodies contain `password`, so this covers both by default.
const SENSITIVE_KEY =
	/(password|passwd|pwd|token|jwt|authorization|api[_-]?key|apikey|secret|credential|cookie|session|signature)/i;

// Values that are secrets regardless of the column they belong to. Bcrypt hashes
// are 60 chars starting with $2a/$2b/$2y, JWT signatures and Grafana tokens are
// long base64url/base64 strings, and API keys are long hex strings.
const SECRET_VALUE =
	/^(?:\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}|[A-Za-z0-9_-]{24,}|glc_[A-Za-z0-9+/=]+|[0-9a-f]{32,})$/;

// Request-scoped context (request id + authenticated user) shared with the
// database and factory logs without threading parameters through every call.
const storage = new AsyncLocalStorage();

// ---------------------------------------------------------------------------
// Buffering
// ---------------------------------------------------------------------------

const queue = [];
let flushTimer = null;
let flushChain = Promise.resolve();
let lastTimestampNs = 0n;
let discardedEntries = 0;

function isConfigured() {
	const logging = config.logging;
	return Boolean(logging?.endpointUrl && logging?.accountId && logging?.apiKey);
}

function sourceLabel() {
	return config.logging?.source || "jwt-pizza-service";
}

function labelsFor(type, level) {
	return { source: sourceLabel(), type, level };
}

// Loki requires timestamps to be strictly increasing per stream. Date.now() can
// return the same millisecond for many events, so bump by one nanosecond when
// needed instead of relying on the ingester to sort duplicates.
function nextTimestampNs() {
	let timestamp = BigInt(Date.now()) * 1_000_000n;
	if (timestamp <= lastTimestampNs) {
		timestamp = lastTimestampNs + 1n;
	}
	lastTimestampNs = timestamp;
	return timestamp.toString();
}

function currentContext() {
	const store = storage.getStore();
	if (!store) {
		return {};
	}
	return {
		requestId: store.requestId,
		user: store.user,
	};
}

function enqueue(type, level, message, fields = {}) {
	if (!isConfigured()) {
		return false;
	}

	const context = currentContext();
	const event = sanitize({
		timestamp: new Date().toISOString(),
		level,
		type,
		message,
		...(context.requestId ? { requestId: context.requestId } : {}),
		...(context.user ? { user: context.user } : {}),
		...fields,
	});

	let line = safeStringify(event);
	if (line.length > MAX_LINE_CHARS) {
		line = `${line.slice(0, MAX_LINE_CHARS)}...[truncated]`;
	}

	if (queue.length >= MAX_QUEUE_ENTRIES) {
		queue.shift();
		discardedEntries += 1;
	}
	queue.push({
		labels: labelsFor(type, level),
		line,
		timestampNs: nextTimestampNs(),
	});
	return true;
}

// ---------------------------------------------------------------------------
// Public logging helpers
// ---------------------------------------------------------------------------

function userSummary(user) {
	if (!user || typeof user !== "object") {
		return undefined;
	}
	if (user.id === undefined && user.email === undefined) {
		return undefined;
	}
	return { id: user.id, email: user.email };
}

function requestIdFor(req) {
	// Trust an upstream proxy/provided id if one exists, otherwise mint one.
	return req?.headers?.["x-request-id"] || randomUUID();
}

// Express middleware: establishes the AsyncLocalStorage context and records one
// structured event per HTTP request, including the (sanitized) request and
// response bodies. Register before express.json()/routes so rejected requests
// are logged too; req.body/req.user are read when the response finishes.
function httpLogger(req, res, next) {
	const store = { requestId: requestIdFor(req), user: undefined };
	return storage.run(store, () => {
		const start = process.hrtime.bigint();
		let responseBody;

		const originalSend = res.send;
		res.send = function send(body) {
			responseBody = body;
			return originalSend.call(this, body);
		};

		res.on("finish", () => {
			const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
			const path = (req.originalUrl ?? req.url ?? "").split("?")[0];
			const statusCode = res.statusCode;
			let level = "info";
			if (statusCode >= 500) {
				level = "error";
			} else if (statusCode >= 400) {
				level = "warn";
			}

			enqueue("http", level, `${req.method} ${path} ${statusCode}`, {
				method: req.method,
				path,
				route: routePatternOf(req),
				statusCode,
				durationMs: Number(durationMs.toFixed(3)),
				hasAuthHeader: Boolean(req.headers?.authorization),
				user: userSummary(req.user ?? store.user),
				requestBody: sanitizeBody(req.body),
				responseBody: sanitizeBody(responseBody),
			});
		});

		next();
	});
}

// Registered after setAuthUser so database/factory logs inside the request can
// name the caller without every DB method taking a user argument.
function userContext(req, _res, next) {
	const store = storage.getStore();
	if (store) {
		store.user = userSummary(req.user);
	}
	next();
}

function routePatternOf(req) {
	if (!req.route?.path) {
		return undefined;
	}
	const pattern = `${req.baseUrl ?? ""}${req.route.path}`;
	return pattern.length > 1 ? pattern.replace(/\/$/, "") : pattern;
}

function databaseQuery({ sql, params, durationMs, rowCount, error }) {
	const level = error ? "error" : "info";
	const message = error ? "database query failed" : "database query";
	return enqueue("database", level, message, {
		sql: sanitizeSql(sql),
		params: sanitizeParams(params),
		durationMs:
			typeof durationMs === "number"
				? Number(durationMs.toFixed(3))
				: undefined,
		rowCount,
		error: error ? errorDetails(error) : undefined,
	});
}

function factoryRequest({
	user,
	url,
	requestBody,
	responseBody,
	statusCode,
	durationMs,
	error,
}) {
	const failed = Boolean(error) || statusCode >= 400;
	return enqueue(
		"factory",
		failed ? "error" : "info",
		`factory request ${statusCode ?? "failed"}`,
		{
			url: sanitizeSql(url),
			statusCode,
			durationMs:
				typeof durationMs === "number"
					? Number(durationMs.toFixed(3))
					: undefined,
			user: userSummary(user) ?? currentContext().user,
			requestBody: sanitizeBody(requestBody),
			responseBody: sanitizeBody(responseBody),
			error: error ? errorDetails(error) : undefined,
		},
	);
}

// Any error that reaches the Express error handler or the process handlers.
function exception(error, fields = {}) {
	return enqueue("exception", "error", error?.message ?? String(error), {
		error: errorDetails(error),
		...fields,
	});
}

function system(message, fields = {}) {
	return enqueue("system", "info", message, fields);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function takeBatch() {
	const batch = [];
	let bytes = 0;
	while (queue.length > 0 && batch.length < MAX_BATCH_ENTRIES) {
		const next = queue[0];
		if (batch.length > 0 && bytes + next.line.length > MAX_BATCH_BYTES) {
			break;
		}
		queue.shift();
		batch.push(next);
		bytes += next.line.length;
	}
	return batch;
}

function toPayload(batch) {
	const streams = new Map();
	for (const entry of batch) {
		const key = JSON.stringify(entry.labels);
		if (!streams.has(key)) {
			streams.set(key, { stream: entry.labels, values: [] });
		}
		streams.get(key).values.push([entry.timestampNs, entry.line]);
	}
	return { streams: [...streams.values()] };
}

async function sendBatch(batch) {
	const logging = config.logging;
	const response = await fetch(logging.endpointUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${logging.accountId}:${logging.apiKey}`,
		},
		body: JSON.stringify(toPayload(batch)),
		// Do not let a slow Grafana request keep the process alive or pile up
		// batches; timers are unref'd but a shutdown flush awaits this promise.
		signal: AbortSignal.timeout(5_000),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Grafana responded ${response.status}: ${body.slice(0, 200)}`,
		);
	}
}

async function flush() {
	if (!isConfigured() || queue.length === 0) {
		return;
	}

	const batch = takeBatch();
	if (discardedEntries > 0) {
		system("log queue overflow, dropped entries", {
			discardedEntries,
			queueLimit: MAX_QUEUE_ENTRIES,
		});
		discardedEntries = 0;
	}

	// One retry smooths over a transient network blip without letting the queue
	// grow without bound; after that the batch is dropped.
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await sendBatch(batch);
			return;
		} catch (error) {
			if (attempt === 1) {
				// console.error is the only sink left; never throw from logging.
				console.error(`Failed to send logs to Grafana: ${error.message}`);
			}
		}
	}
}

// Serialize flushes so batches reach Loki in timestamp order.
function scheduleFlush() {
	flushChain = flushChain.then(flush, flush);
	return flushChain;
}

function start(period = FLUSH_INTERVAL_MS) {
	if (!isConfigured()) {
		console.log("Logging disabled: config.logging is not configured");
		return null;
	}
	if (flushTimer) {
		return flushTimer;
	}

	flushTimer = setInterval(() => {
		scheduleFlush();
	}, period);
	// Do not keep the process (or a test run) alive just to send logs.
	flushTimer.unref?.();
	return flushTimer;
}

function stop() {
	if (flushTimer) {
		clearInterval(flushTimer);
		flushTimer = null;
	}
}

// ---------------------------------------------------------------------------
// Sanitization
//
// All log data passes through here: key names that look sensitive are redacted,
// long values are truncated, and SQL literals/parameters that hold credentials
// are replaced. Logging must never leak a password, JWT, or API key.
// ---------------------------------------------------------------------------

function truncate(value, max = MAX_FIELD_CHARS) {
	if (typeof value !== "string" || value.length <= max) {
		return value;
	}
	return `${value.slice(0, max)}...[truncated]`;
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
	if (value === null || value === undefined) {
		return value;
	}

	const valueType = typeof value;
	if (valueType === "string") {
		return truncate(value);
	}
	if (valueType === "number" || valueType === "boolean") {
		return value;
	}
	if (valueType === "bigint") {
		return value.toString();
	}
	if (valueType === "function" || valueType === "symbol") {
		return "[unserializable]";
	}

	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof Error) {
		return errorDetails(value);
	}
	if (Buffer.isBuffer(value)) {
		return `[binary ${value.length} bytes]`;
	}
	if (depth >= MAX_DEPTH) {
		return "[max depth]";
	}
	if (seen.has(value)) {
		return "[circular]";
	}
	seen.add(value);

	if (Array.isArray(value)) {
		return value
			.slice(0, MAX_ARRAY_ITEMS)
			.map((item) => sanitize(item, depth + 1, seen));
	}

	const result = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = SENSITIVE_KEY.test(key)
			? "[REDACTED]"
			: sanitize(item, depth + 1, seen);
	}
	return result;
}

function sanitizeBody(body) {
	if (body === undefined || body === null) {
		return body;
	}

	let value = body;
	if (typeof body === "string") {
		try {
			value = JSON.parse(body);
		} catch {
			value = body;
		}
	}
	return sanitize(value);
}

function sanitizeSql(sql) {
	if (typeof sql !== "string") {
		return sql;
	}
	// updateUser builds `password='<bcrypt hash>'` into the SQL string itself.
	return sql.replace(
		/((?:password|passwd|pwd|token|secret|api[_-]?key|apikey)\s*=\s*)'[^']*'/gi,
		"$1'[REDACTED]'",
	);
}

function sanitizeParams(params) {
	if (!Array.isArray(params)) {
		return params;
	}
	return params.map((param) =>
		typeof param === "string" && SECRET_VALUE.test(param)
			? "[REDACTED]"
			: sanitize(param),
	);
}

function errorDetails(error) {
	if (!error) {
		return undefined;
	}
	if (typeof error !== "object") {
		return { message: truncate(String(error)) };
	}
	return {
		name: error.name,
		message: truncate(error.message ?? String(error)),
		code: error.code,
		stack: truncate(error.stack, 4_000),
	};
}

function safeStringify(value) {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return JSON.stringify({ message: "unable to serialize log entry" });
	}
}

module.exports = {
	// middleware
	httpLogger,
	userContext,
	// event helpers
	databaseQuery,
	factoryRequest,
	exception,
	system,
	// lifecycle / transport
	start,
	stop,
	flush,
	scheduleFlush,
	isConfigured,
	// exposed for tests
	sanitize,
	sanitizeBody,
	sanitizeSql,
	sanitizeParams,
	userSummary,
	MAX_QUEUE_ENTRIES,
};
