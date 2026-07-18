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

# Copy frontend package files for caching
COPY frontend/package.json frontend/
COPY frontend/package-lock.json frontend/  # harmless if missing

# Install frontend deps: prefer npm ci if lockfile exists, otherwise npm install
RUN cd frontend && \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy full frontend and build
COPY frontend/ frontend/
RUN cd frontend && npm run build


ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
