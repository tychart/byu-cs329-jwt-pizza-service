const { execSync } = require("child_process");
const request = require("supertest");
const app = require("../../service.js");

// 1. Load environment variables from your .env file
require("dotenv").config({ quiet: true });

const { Role, DB } = require("../../database/database.js");
const { setAuth } = require("../../routes/authRouter.js");

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testUser = { name: "pizza diner", email: "reg@test.com", password: "a" };
let testUserAuthToken;
let testUserId;

const adminUser = {
	name: "pizza admin",
	email: "admin@test.com",
	password: "a",
	roles: [{ role: Role.Admin }],
};
let adminAuthToken;

function expectValidJwt(potentialJwt) {
	expect(potentialJwt).toMatch(
		/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
	);
}

function randomName() {
	return Math.random().toString(36).substring(2, 12);
}

beforeAll(async () => {
	testUser.email = randomName() + "@test.com";

	// Make sure Database is up
	if (process.env.RUN_LOCAL_CONTAINERS === "true") {
		try {
			execSync("cd ~/programs/containers/mysql/ && podman compose up -d");
		} catch (error) {
			console.error("Failed to execute script before tests:", error);
			throw error; // Fail the test suite if the setup script fails
		}
	}

	// Register a regular diner user
	const registerRes = await request(app).post("/api/auth").send(testUser);
	testUserAuthToken = registerRes.body.token;
	testUserId = registerRes.body.user.id;
	expectValidJwt(testUserAuthToken);

	// Create an admin user directly in the DB (registration always gives diner role)
	adminUser.name = randomName();
	adminUser.email = adminUser.name + "@admin.com";
	const adminDbUser = await DB.addUser(adminUser);
	adminUser.id = adminDbUser.id;
	adminAuthToken = await setAuth(adminDbUser);
	expectValidJwt(adminAuthToken);
});

// ---------------------------------------------------------------------------
// GET /api/user/me – get authenticated user
// ---------------------------------------------------------------------------

test("GET /api/user/me – returns the authenticated user", async () => {
	const res = await request(app)
		.get("/api/user/me")
		.set("Authorization", `Bearer ${testUserAuthToken}`);

	expect(res.status).toBe(200);
	expect(res.body).toMatchObject({
		id: testUserId,
		name: testUser.name,
		email: testUser.email,
	});
	expect(res.body.roles).toEqual([{ role: "diner" }]);
});

test("GET /api/user/me – rejects unauthenticated request", async () => {
	const res = await request(app).get("/api/user/me");

	expect(res.status).toBe(401);
	expect(res.body).toEqual({ message: "unauthorized" });
});

// ---------------------------------------------------------------------------
// PUT /api/user/:userId – update user
// ---------------------------------------------------------------------------

test("PUT /api/user/:userId – user can update their own profile", async () => {
	const newName = "updated-" + randomName();

	const res = await request(app)
		.put(`/api/user/${testUserId}`)
		.set("Authorization", `Bearer ${testUserAuthToken}`)
		.send({ name: newName, email: testUser.email });

	expect(res.status).toBe(200);
	expect(res.body.user).toMatchObject({
		id: testUserId,
		name: newName,
		email: testUser.email,
	});
	expectValidJwt(res.body.token);
});

test("PUT /api/user/:userId – admin can update another user", async () => {
	const newName = "admin-edited-" + randomName();

	const res = await request(app)
		.put(`/api/user/${testUserId}`)
		.set("Authorization", `Bearer ${adminAuthToken}`)
		.send({ name: newName, email: testUser.email });

	expect(res.status).toBe(200);
	expect(res.body.user).toMatchObject({
		id: testUserId,
		name: newName,
		email: testUser.email,
	});
	expectValidJwt(res.body.token);
});

test("PUT /api/user/:userId – non-admin cannot update another user", async () => {
	const res = await request(app)
		.put(`/api/user/${adminUser.id}`)
		.set("Authorization", `Bearer ${testUserAuthToken}`)
		.send({ name: "hacker", email: testUser.email });

	expect(res.status).toBe(403);
	expect(res.body).toEqual({ message: "unauthorized" });
});

test("PUT /api/user/:userId – rejects unauthenticated request", async () => {
	const res = await request(app)
		.put(`/api/user/${testUserId}`)
		.send({ name: "anonymous", email: testUser.email });

	expect(res.status).toBe(401);
	expect(res.body).toEqual({ message: "unauthorized" });
});

// ---------------------------------------------------------------------------
// DELETE /api/user/:userId – delete user
// ---------------------------------------------------------------------------

test("DELETE /api/user/:userId – admin can delete another user", async () => {
	const throwaway = {
		name: "throwaway-" + randomName(),
		email: randomName() + "@test.com",
		password: "a",
		roles: [{ role: Role.Diner }],
	};
	const created = await DB.addUser(throwaway);

	const res = await request(app)
		.delete(`/api/user/${created.id}`)
		.set("Authorization", `Bearer ${adminAuthToken}`);

	expect(res.status).toBe(200);
	expect(res.body).toEqual({ message: "user deleted" });
	await expect(DB.getUser(throwaway.email)).rejects.toThrow("unknown user");
});

test("DELETE /api/user/:userId – user can delete their own account", async () => {
	const throwaway = {
		name: "selfdelete-" + randomName(),
		email: randomName() + "@test.com",
		password: "a",
		roles: [{ role: Role.Diner }],
	};
	const created = await DB.addUser(throwaway);
	const token = await setAuth(created);

	const res = await request(app)
		.delete(`/api/user/${created.id}`)
		.set("Authorization", `Bearer ${token}`);

	expect(res.status).toBe(200);
	expect(res.body).toEqual({ message: "user deleted" });
});

test("DELETE /api/user/:userId – non-admin cannot delete another user", async () => {
	const res = await request(app)
		.delete(`/api/user/${adminUser.id}`)
		.set("Authorization", `Bearer ${testUserAuthToken}`);

	expect(res.status).toBe(403);
	expect(res.body).toMatchObject({ message: "unauthorized" });
});

test("DELETE /api/user/:userId – rejects unauthenticated request", async () => {
	const res = await request(app).delete(`/api/user/${testUserId}`);

	expect(res.status).toBe(401);
	expect(res.body).toEqual({ message: "unauthorized" });
});

// ---------------------------------------------------------------------------
// GET /api/user – list users
// ---------------------------------------------------------------------------

test("GET /api/user – rejects unauthenticated request", async () => {
	const res = await request(app).get("/api/user");

	expect(res.status).toBe(401);
	expect(res.body).toEqual({ message: "unauthorized" });
});

test("GET /api/user – returns users with their roles", async () => {
	const res = await request(app)
		.get(`/api/user?name=${adminUser.name}`)
		.set("Authorization", `Bearer ${adminAuthToken}`);

	expect(res.status).toBe(200);
	expect(Array.isArray(res.body.users)).toBe(true);
	expect(res.body).toHaveProperty("more");
	const listed = res.body.users.find((u) => u.email === adminUser.email);
	expect(listed).toMatchObject({
		name: adminUser.name,
		email: adminUser.email,
	});
	expect(listed.roles).toEqual([{ role: "admin" }]);
});

test("GET /api/user – filters users by name", async () => {
	const prefix = "filter-" + randomName();
	for (let i = 0; i < 3; i++) {
		await DB.addUser({
			name: `${prefix}-${i}`,
			email: randomName() + "@test.com",
			password: "a",
			roles: [{ role: Role.Diner }],
		});
	}

	const res = await request(app)
		.get(`/api/user?name=${prefix}*`)
		.set("Authorization", `Bearer ${adminAuthToken}`);

	expect(res.status).toBe(200);
	expect(res.body.users).toHaveLength(3);
	for (const user of res.body.users) {
		expect(user.name).toContain(prefix);
	}
});

test("GET /api/user – paginates users and reports more", async () => {
	const prefix = "page-" + randomName();
	for (let i = 0; i < 3; i++) {
		await DB.addUser({
			name: `${prefix}-${i}`,
			email: randomName() + "@test.com",
			password: "a",
			roles: [{ role: Role.Diner }],
		});
	}

	const firstPage = await request(app)
		.get(`/api/user?page=1&limit=2&name=${prefix}*`)
		.set("Authorization", `Bearer ${adminAuthToken}`);

	expect(firstPage.status).toBe(200);
	expect(firstPage.body.users).toHaveLength(2);
	expect(firstPage.body.more).toBe(true);

	const secondPage = await request(app)
		.get(`/api/user?page=2&limit=2&name=${prefix}*`)
		.set("Authorization", `Bearer ${adminAuthToken}`);

	expect(secondPage.status).toBe(200);
	expect(secondPage.body.users).toHaveLength(1);
	expect(secondPage.body.more).toBe(false);

	const firstIds = firstPage.body.users.map((u) => u.id);
	const secondIds = secondPage.body.users.map((u) => u.id);
	for (const id of secondIds) {
		expect(firstIds).not.toContain(id);
	}
});
