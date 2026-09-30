# 🍕 jwt-pizza-service

![Coverage badge](https://pizza-factory.cs329.click/api/badge/tychart/jwtpizzaservicecoverage)

Backend service for making JWT pizzas. This service tracks users and franchises and orders pizzas. All order requests are passed to the JWT Pizza Factory where the pizzas are made.

JWTs are used for authentication objects.

## Local development (Fedora 44)

Everything runs natively on your machine except MySQL, which runs in a Podman container. The complete stack is:

```
MySQL (Podman, :3306)  →  this service (Bun, :3000)  →  JWT Pizza frontend (Vite, :5173)
```

### 1. Install prerequisites

```sh
sudo dnf install -y git curl jq nodejs podman podman-compose
curl -fsSL https://bun.sh/install | bash
# then reopen your terminal (or run: source ~/.bashrc)
```

| Tool | Why |
| --- | --- |
| `bun` | Package manager, task runner, and runtime — use it for everything |
| `nodejs` | Required only because Jest and ESLint run on Node; run them through Bun |
| `podman` + `podman-compose` | Runs MySQL |
| `curl` + `jq` | Used by `generatePizzaData.sh` |

> **Bun first.** Use `bun` / `bunx` for installing and running everything (`bun install`, `bun run start`, `bun run test`). Jest is the one Node-bound piece: `bun run test` delegates to Node for it. Always use `bun run test` (not `bun test`, which would invoke Bun's own test runner) and don't add `--bun`.

Verify:

```sh
bun --version && node --version && podman --version
```

### 2. Start MySQL in Podman

The test suite auto-starts the container from `~/programs/containers/mysql`, so create it exactly there.

```sh
mkdir -p ~/programs/containers/mysql/init
```

Create `~/programs/containers/mysql/compose.yml`:

```yaml
services:
  mysql-db:
    image: docker.io/library/mysql:8.4
    container_name: mysql_podman
    restart: always
    ports:
      - "3306:3306"
    environment:
      MYSQL_ROOT_PASSWORD: my-strong-root-password
      MYSQL_DATABASE: my_database
      MYSQL_USER: my_user
      MYSQL_PASSWORD: my_user_password
    volumes:
      # The :Z flag resolves SELinux permission errors common in Podman
      - mysql_data:/var/lib/mysql:Z
      # Grants needed by the pizza service (it creates the `pizza` db itself).
      # Only executes when mysql_data is empty (i.e. after `podman compose down -v`).
      - ./init:/docker-entrypoint-initdb.d:Z,ro
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "my_user", "-pmy_user_password"]
      interval: 2s      # How often to run the check
      timeout: 2s       # How long to wait for a response before failing
      retries: 10       # Try up to 10 times before declaring the container unhealthy
      start_period: 5s  # Give the DB 5 seconds to boot before checking

volumes:
  mysql_data:
```

Create `~/programs/containers/mysql/init/01-pizza-grants.sql`:

```sql
-- Runs once, on first initialization of an empty data dir.
-- The service creates the `pizza` database itself, so my_user needs rights on it.
GRANT ALL PRIVILEGES ON `pizza`.* TO 'my_user'@'%';
FLUSH PRIVILEGES;
```

Start MySQL and wait until it is healthy:

```sh
cd ~/programs/containers/mysql
podman compose up -d

until [ "$(podman inspect --format '{{.State.Health.Status}}' mysql_podman 2>/dev/null)" = "healthy" ]; do
  sleep 1
done
echo "MySQL is ready on localhost:3306"
```

Useful container commands:

```sh
podman compose logs -f                             # follow logs
podman compose down                                # stop the database
podman compose down -v && podman compose up -d     # wipe data and recreate
```

### 3. Clone, install, and configure

```sh
git clone git@github.com:tychart/byu-cs329-jwt-pizza-service.git
cd byu-cs329-jwt-pizza-service
bun install
```

Create `.env` (gitignored):

```sh
echo "RUN_LOCAL_CONTAINERS=true" > .env
```

With this set, `bun run test` will start the MySQL container automatically.

Create `src/config.js` (gitignored) and match it to the container:

```js
module.exports = {
  // Any long random string. Generate one with: openssl rand -hex 16
  jwtSecret: 'change-me-to-a-random-string',
  db: {
    connection: {
      host: '127.0.0.1',
      user: 'my_user',
      password: 'my_user_password',
      database: 'pizza',
      connectTimeout: 60000,
    },
    listPerPage: 10,
  },
  factory: {
    url: 'https://pizza-factory.cs329.click',
    apiKey: 'your-factory-api-key',
  },
};
```

`db` matches the container. `factory.apiKey` is only needed for pizza verification; use the key from your course materials.

### 4. Run the service and seed data

```sh
bun run start        # http://localhost:3000
```

The service creates the `pizza` database and all of its tables on first start.

In a second terminal, create the admin user and load the demo data:

```sh
bun src/init.js admin a@jwt.com admin
./generatePizzaData.sh http://localhost:3000
```

Seeded accounts:

| Email | Password | Role |
| --- | --- | --- |
| a@jwt.com | admin | admin |
| d@jwt.com | diner | diner |
| f@jwt.com | franchisee | franchisee |

### 5. Run the tests

```sh
bun run test            # Jest (auto-starts MySQL if .env has RUN_LOCAL_CONTAINERS=true)
bun run test:coverage   # Jest with coverage
bun run lint            # ESLint
```

## Deployment

In order for the server to work correctly it must be configured by providing a `config.js` file.

```js
module.exports =  {
    // Your JWT secret can be any random string you would like. It just needs to be secret.
   jwtSecret: 'yourjwtsecrethere',
   db: {
   connection: {
      host: '127.0.0.1',
      user: 'root',
      password: 'yourpasswordhere',
      database: 'pizza',
      connectTimeout: 60000,
   },
   listPerPage: 10,
   },
   factory: {
   url: 'https://pizza-factory.cs329.click',
   apiKey: 'yourapikeyhere',
   },
};
```

## Endpoints

You can get the documentation for all endpoints by making the following request.

```sh
curl localhost:3000/api/docs
```

## Development notes

Nodemon is assumed to be installed globally so that you can have hot reloading when debugging.

```sh
bun add -g nodemon
```
