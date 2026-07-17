# Stage 1: Build frontend
FROM node:18-alpine AS builder
WORKDIR /app

# Install frontend deps and build
COPY frontend/package*.json frontend/
RUN cd frontend && npm ci
COPY frontend/ frontend/
RUN cd frontend && npm run build

# Stage 2: Build runtime image for backend
FROM node:18-alpine AS runtime
WORKDIR /app

# Install backend production deps
COPY package*.json ./
RUN npm ci --only=production

# Copy backend source
COPY . .

# Copy frontend build into backend public folder
COPY --from=builder /app/frontend/dist ./public

# Ensure server listens on 0.0.0.0:8080
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]

