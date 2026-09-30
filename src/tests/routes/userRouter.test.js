const { execSync } = require('child_process');
const request = require('supertest');
const app = require('../../service.js');

// 1. Load environment variables from your .env file
require('dotenv').config({ quiet: true });

const { Role, DB } = require('../../database/database.js');
const { setAuth } = require('../../routes/authRouter.js');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;
let testUserId;

const adminUser = { name: 'pizza admin', email: 'admin@test.com', password: 'a', roles: [{ role: Role.Admin }] };
let adminAuthToken;

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

beforeAll(async () => {
  testUser.email = randomName() + '@test.com';

  // Make sure Database is up
  if (process.env.RUN_LOCAL_CONTAINERS === 'true') {
    try {
      execSync('cd ~/programs/containers/mysql/ && podman compose up -d');
    } catch (error) {
      console.error('Failed to execute script before tests:', error);
      throw error; // Fail the test suite if the setup script fails
    }
  }

  // Register a regular diner user
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
  testUserId = registerRes.body.user.id;
  expectValidJwt(testUserAuthToken);

  // Create an admin user directly in the DB (registration always gives diner role)
  adminUser.name = randomName();
  adminUser.email = adminUser.name + '@admin.com';
  const adminDbUser = await DB.addUser(adminUser);
  adminUser.id = adminDbUser.id;
  adminAuthToken = await setAuth(adminDbUser);
  expectValidJwt(adminAuthToken);
});

// ---------------------------------------------------------------------------
// GET /api/user/me – get authenticated user
// ---------------------------------------------------------------------------

test('GET /api/user/me – returns the authenticated user', async () => {
  const res = await request(app)
    .get('/api/user/me')
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ id: testUserId, name: testUser.name, email: testUser.email });
  expect(res.body.roles).toEqual([{ role: 'diner' }]);
});

test('GET /api/user/me – rejects unauthenticated request', async () => {
  const res = await request(app).get('/api/user/me');

  expect(res.status).toBe(401);
  expect(res.body).toEqual({ message: 'unauthorized' });
});

// ---------------------------------------------------------------------------
// PUT /api/user/:userId – update user
// ---------------------------------------------------------------------------

test('PUT /api/user/:userId – user can update their own profile', async () => {
  const newName = 'updated-' + randomName();

  const res = await request(app)
    .put(`/api/user/${testUserId}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send({ name: newName, email: testUser.email });

  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: testUserId, name: newName, email: testUser.email });
  expectValidJwt(res.body.token);
});

test('PUT /api/user/:userId – admin can update another user', async () => {
  const newName = 'admin-edited-' + randomName();

  const res = await request(app)
    .put(`/api/user/${testUserId}`)
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .send({ name: newName, email: testUser.email });

  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: testUserId, name: newName, email: testUser.email });
  expectValidJwt(res.body.token);
});

test('PUT /api/user/:userId – non-admin cannot update another user', async () => {
  const res = await request(app)
    .put(`/api/user/${adminUser.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send({ name: 'hacker', email: testUser.email });

  expect(res.status).toBe(403);
  expect(res.body).toEqual({ message: 'unauthorized' });
});

test('PUT /api/user/:userId – rejects unauthenticated request', async () => {
  const res = await request(app)
    .put(`/api/user/${testUserId}`)
    .send({ name: 'anonymous', email: testUser.email });

  expect(res.status).toBe(401);
  expect(res.body).toEqual({ message: 'unauthorized' });
});

// ---------------------------------------------------------------------------
// DELETE /api/user/:userId – delete user (not implemented)
// ---------------------------------------------------------------------------

test('DELETE /api/user/:userId – returns not implemented', async () => {
  const res = await request(app)
    .delete(`/api/user/${testUserId}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'not implemented' });
});

test('DELETE /api/user/:userId – rejects unauthenticated request', async () => {
  const res = await request(app).delete(`/api/user/${testUserId}`);

  expect(res.status).toBe(401);
  expect(res.body).toEqual({ message: 'unauthorized' });
});

// ---------------------------------------------------------------------------
// GET /api/user – list users (not implemented)
// ---------------------------------------------------------------------------

test('GET /api/user – returns empty user list placeholder', async () => {
  const res = await request(app)
    .get('/api/user')
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'not implemented', users: [], more: false });
});

test('GET /api/user – rejects unauthenticated request', async () => {
  const res = await request(app).get('/api/user');

  expect(res.status).toBe(401);
  expect(res.body).toEqual({ message: 'unauthorized' });
});
