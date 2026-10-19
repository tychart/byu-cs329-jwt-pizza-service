FROM oven/bun:alpine

WORKDIR /usr/src/app

# Copy only manifest + lockfile first for better layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Now copy everything else (respecting .containerignore)
COPY . .

EXPOSE 80

CMD ["bun", "src/index.js", "80"]