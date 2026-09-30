const { execSync } = require('child_process');
const request = require('supertest');
const app = require('../../service');

// 1. Load environment variables from your .env file
require('dotenv').config({ quiet: true }); 

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';

  // Make sure Database is up
  if (process.env.RUN_LOCAL_CONTAINERS === 'true') {
    try {
      // 2. Run your shell command or script here
      // Example running a command: execSync('npm run db:reset');
      // Example running a script: execSync('sh ./scripts/setup.sh');
      execSync('cd ~/programs/containers/mysql/ && podman compose up -d'); 
      // console.log("Executed shell command to start up podman db")
    } catch (error) {
      console.error('Failed to execute script before tests:', error);
      throw error; // Fail the test suite if the setup script fails
    }
  }



  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
  expectValidJwt(testUserAuthToken);
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...testUser, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

test('register', async () => {
  const registerResBad = await request(app).post('/api/auth');
  expect(registerResBad.status).toBe(400);
  
  const registerRes = await request(app).post('/api/auth').send(testUser);
  expect(registerRes.status).toBe(200);
  expectValidJwt(registerRes.body.token);

  const expectedUser = { ...testUser, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(registerRes.body.user).toMatchObject(expectedUser);
});

test('logout', async () => {
  const deleteResBad = await request(app)
    .delete('/api/auth')
    .set('Authorization', `Bearer notavalidauthtoken`);
  expect(deleteResBad.status).toBe(401);
  
  
  const deleteRes = await request(app)
    .delete('/api/auth')
    .set('Authorization', `Bearer ${testUserAuthToken}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toMatchObject({ message: 'logout successful' });
});

