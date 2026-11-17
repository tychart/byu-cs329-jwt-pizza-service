const express = require("express");
const metrics = require("./metrics.js");
const logger = require("./logger.js");
const { authRouter, setAuthUser } = require("./routes/authRouter.js");
const orderRouter = require("./routes/orderRouter.js");
const franchiseRouter = require("./routes/franchiseRouter.js");
const userRouter = require("./routes/userRouter.js");
const version = require("./version.json");
const config = require("./config.js");

const app = express();
// Registered first so every request, including rejected ones, is counted.
app.use(metrics.requestTracker);
// Opens a logging context before anything can fail; logs are sent in the
// background so requests never wait on Grafana.
app.use(logger.httpLogger);
app.use(express.json());
app.use(setAuthUser);
// Makes the authenticated user available to database/factory logging.
app.use(logger.userContext);
app.use((req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
	res.setHeader("Access-Control-Allow-Credentials", "true");
	next();
});

const apiRouter = express.Router();
app.use("/api", apiRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/user", userRouter);
apiRouter.use("/order", orderRouter);
apiRouter.use("/franchise", franchiseRouter);

apiRouter.use("/docs", (req, res) => {
	res.json({
		version: version.version,
		endpoints: [
			...authRouter.docs,
			...userRouter.docs,
			...orderRouter.docs,
			...franchiseRouter.docs,
		],
		config: { factory: config.factory.url, db: config.db.connection.host },
	});
});

app.get("/", (req, res) => {
	res.json({
		message: "welcome to JWT Pizza",
		version: version.version,
	});
});

app.use("*", (req, res) => {
	res.status(404).json({
		message: "unknown endpoint",
	});
});

// Default error handler for all exceptions and errors.
app.use((err, req, res, next) => {
	logger.exception(err, {
		request: { method: req.method, path: req.path },
	});
	res
		.status(err.statusCode ?? 500)
		.json({ message: err.message, stack: err.stack });
});

module.exports = app;
