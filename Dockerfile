# Stage 1: Build frontend
FROM node:20-alpine AS builder
WORKDIR /app

# Copy frontend package files for caching
COPY frontend/package*.json frontend/
RUN cd frontend && \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy frontend source and build
COPY frontend/ frontend/
RUN cd frontend && npm run build

# Stage 2: Runtime image for backend
FROM node:20-alpine AS runtime
WORKDIR /app

# Copy backend package files and install production deps
COPY package.json package-lock.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --production; fi

# Copy backend source
COPY . .

# Ensure frontend build is present in runtime image
COPY --from=builder /app/frontend/dist frontend/dist

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
