const app = require("./service.js");

const port = process.argv[2] || 3000;
app.listen(port, () => {
	console.log(`Server started on port ${port}`);
});

// Bun runs as PID 1 in the container, and Linux ignores default-action signals
// for PID 1. Installing handlers makes SIGTERM (podman stop) and SIGINT
// (Ctrl+C / podman kill -s INT) shut the service down gracefully.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Don't hang on lingering keep-alive connections.
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
