const { execSync } = require('child_process');
const request = require('supertest');
const app = require('../../service');

// 1. Load environment variables from your .env file
require('dotenv').config({ quiet: true });

const { Role, DB } = require('../../database/database.js');
const { setAuth } = require('../../routes/authRouter');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

const adminUser = { name: 'pizza admin', email: 'admin@test.com', password: 'a', roles: [{ role: Role.Admin }] };
let adminAuthToken;

let createdFranchiseId;
let franchiseName;

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

// ---------------------------------------------------------------------------
// Setup – register users, create admin, create a franchise
// ---------------------------------------------------------------------------

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';

  // Make sure Database is up
  if (process.env.RUN_LOCAL_CONTAINERS === 'true') {
    try {
      execSync('cd ~/programs/containers/mysql/ && podman compose up -d');
    } catch (error) {
      console.error('Failed to execute script before tests:', error);
      throw error;
    }
  }

  // Register regular diner user
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
  testUser.id = registerRes.body.user.id;
  expectValidJwt(testUserAuthToken);

  // Create an admin user directly in the DB (registration always gives diner role)
  adminUser.name = randomName();
  adminUser.email = adminUser.name + '@admin.com';
  const adminDbUser = await DB.addUser(adminUser);
  adminUser.id = adminDbUser.id;
  adminAuthToken = await setAuth(adminDbUser);
  expectValidJwt(adminAuthToken);

  // Create a franchise (admin only) – stores franchise id for other tests.
  // The name is randomized because `franchise.name` is UNIQUE, so fixed names
  // would collide with rows left over from a previous test run.
  franchiseName = 'TestFranchise-' + randomName();
  const franchiseRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .set('Content-Type', 'application/json')
    .send({
      name: franchiseName,
      admins: [{ email: adminUser.email }],
    });
  createdFranchiseId = franchiseRes.body.id;
});

// ---------------------------------------------------------------------------
// GET /api/franchise – list all franchises
// ---------------------------------------------------------------------------

test('GET /api/franchise – returns paginated franchises', async () => {
  const res = await request(app)
    .get(`/api/franchise?page=0&limit=10&name=${franchiseName}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('franchises');
  expect(res.body).toHaveProperty('more');
  expect(res.body.franchises.length).toBeGreaterThanOrEqual(1);
});

test('GET /api/franchise – works without auth (route has no auth guard)', async () => {
  const res = await request(app).get('/api/franchise');
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('franchises');
});

// ---------------------------------------------------------------------------
// GET /api/franchise/:userId – list user's franchises
// ---------------------------------------------------------------------------

test('GET /api/franchise/:userId – returns user franchises for admin', async () => {
  const res = await request(app)
    .get(`/api/franchise/${adminUser.id}`)
    .set('Authorization', `Bearer ${adminAuthToken}`);

  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body.length).toBeGreaterThanOrEqual(1);
});

test('GET /api/franchise/:userId – returns empty array for user with no franchises', async () => {
  const res = await request(app)
    .get(`/api/franchise/${testUser.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
});

test('GET /api/franchise/:userId – admin can query any user', async () => {
  const res = await request(app)
    .get(`/api/franchise/${testUser.id}`)
    .set('Authorization', `Bearer ${adminAuthToken}`);

  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

// ---------------------------------------------------------------------------
// POST /api/franchise – create a franchise
// ---------------------------------------------------------------------------

test('POST /api/franchise – admin can create a franchise', async () => {
  const anotherFranchiseName = 'AnotherFranchise-' + randomName();
  const newFranchise = { name: anotherFranchiseName, admins: [{ email: testUser.email }] };

  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .set('Content-Type', 'application/json')
    .send(newFranchise);

  expect(res.status).toBe(200);
  expect(res.body.name).toBe(anotherFranchiseName);
  expect(res.body).toHaveProperty('id');
  expect(res.body).toHaveProperty('admins');
});

test('POST /api/franchise – non-admin cannot create a franchise', async () => {
  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .set('Content-Type', 'application/json')
    .send({ name: 'UnauthorizedFranchise', admins: [] });

  expect(res.status).toBe(403);
});

test('POST /api/franchise – unauthenticated user cannot create a franchise', async () => {
  const res = await request(app)
    .post('/api/franchise')
    .set('Content-Type', 'application/json')
    .send({ name: 'UnauthorizedFranchise', admins: [] });

  // Missing credentials are rejected by authenticateToken with 401 (not 403).
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// DELETE /api/franchise/:franchiseId – delete a franchise
// ---------------------------------------------------------------------------

test('DELETE /api/franchise/:franchiseId – admin can delete a franchise', async () => {
  // Create a franchise to delete
  const createRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .set('Content-Type', 'application/json')
    .send({ name: 'ToDelete-' + randomName(), admins: [{ email: testUser.email }] });

  const franchiseId = createRes.body.id;

  const res = await request(app)
    .delete(`/api/franchise/${franchiseId}`)
    .set('Authorization', `Bearer ${adminAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'franchise deleted' });
});

// ---------------------------------------------------------------------------
// POST /api/franchise/:franchiseId/store – create a store
// ---------------------------------------------------------------------------

test('POST /api/franchise/:franchiseId/store – admin can create a store', async () => {
  const res = await request(app)
    .post(`/api/franchise/${createdFranchiseId}/store`)
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .set('Content-Type', 'application/json')
    .send({ franchiseId: createdFranchiseId, name: 'TestStore' });

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('id');
  expect(res.body.name).toBe('TestStore');
});

test('POST /api/franchise/:franchiseId/store – non-admin cannot create a store', async () => {
  const res = await request(app)
    .post(`/api/franchise/${createdFranchiseId}/store`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .set('Content-Type', 'application/json')
    .send({ franchiseId: createdFranchiseId, name: 'UnauthorizedStore' });

  expect(res.status).toBe(403);
});

// ---------------------------------------------------------------------------
// DELETE /api/franchise/:franchiseId/store/:storeId – delete a store
// ---------------------------------------------------------------------------

test('DELETE /api/franchise/:franchiseId/store/:storeId – admin can delete a store', async () => {
  // Create a store to delete
  const createStoreRes = await request(app)
    .post(`/api/franchise/${createdFranchiseId}/store`)
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .set('Content-Type', 'application/json')
    .send({ franchiseId: createdFranchiseId, name: 'ToDeleteStore' });

  const storeId = createStoreRes.body.id;

  const res = await request(app)
    .delete(`/api/franchise/${createdFranchiseId}/store/${storeId}`)
    .set('Authorization', `Bearer ${adminAuthToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'store deleted' });
});

test('DELETE /api/franchise/:franchiseId/store/:storeId – non-admin cannot delete a store', async () => {
  // Create a store first
  const createStoreRes = await request(app)
    .post(`/api/franchise/${createdFranchiseId}/store`)
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .set('Content-Type', 'application/json')
    .send({ franchiseId: createdFranchiseId, name: 'ToDeleteStore2' });

  const storeId = createStoreRes.body.id;

  const res = await request(app)
    .delete(`/api/franchise/${createdFranchiseId}/store/${storeId}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(res.status).toBe(403);
});
