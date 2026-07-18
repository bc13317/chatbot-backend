# Stage 1: Build frontend
FROM node:18-alpine AS builder
WORKDIR /app

# Copy package files first for caching
COPY frontend/package.json frontend/
COPY frontend/package-lock.json frontend/  # falls vorhanden; harmless wenn nicht
RUN cd frontend && \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY frontend/ frontend/
RUN cd frontend && npm run build

# Stage 2: Runtime image for backend
FROM node:18-alpine AS runtime
WORKDIR /app

# Install backend production deps
COPY package.json package-lock.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --production; fi

# Copy backend source
COPY . .

# Copy frontend build into backend public folder
COPY --from=builder /app/frontend/dist ./public

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
