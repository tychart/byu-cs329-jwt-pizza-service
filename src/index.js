const app = require("./service.js");
const metrics = require("./metrics.js");
const logger = require("./logger.js");
const version = require("./version.json");

const port = process.argv[2] || 3000;
const server = app.listen(port, () => {
	console.log(`Server started on port ${port}`);
	metrics.startReporting();
	logger.start();
	logger.system("server started", {
		port: Number(port),
		version: version.version,
	});
});

// An async failure that nobody caught would otherwise disappear.
process.on("unhandledRejection", (reason) => {
	logger.exception(reason, { source: "unhandledRejection" });
});

process.on("uncaughtException", (error) => {
	logger.exception(error, { source: "uncaughtException" });
	logger.stop();
	logger.flush().finally(() => process.exit(1));
});

// Bun runs as PID 1 in the container, and Linux ignores default-action signals
// for PID 1. Installing handlers makes SIGTERM (podman stop) and SIGINT
// (Ctrl+C / podman kill -s INT) shut the service down gracefully.
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => {
		console.log(`${signal} received, shutting down`);
		logger.system(`server shutting down: ${signal}`, {
			signal,
			port: Number(port),
		});
		logger.stop();

		const shutdown = (code) => {
			logger.flush().finally(() => process.exit(code));
		};

		server.close(() => shutdown(0));
		// Don't hang on lingering keep-alive connections.
		setTimeout(() => shutdown(1), 5000).unref();
	});
}
