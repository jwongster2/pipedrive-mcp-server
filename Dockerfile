# Multi-stage build for optimized image size
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (use `npm install` so the build works without a committed lockfile)
RUN npm install --no-audit --no-fund

# Copy source code
COPY src ./src

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

# Install wget for healthcheck
RUN apk add --no-cache wget

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev --no-audit --no-fund

# Copy built application from builder stage
COPY --from=builder /app/build ./build

# Set NODE_ENV to production
ENV NODE_ENV=production

# Expose the default MCP port (can be overridden via environment variable)
EXPOSE 3000

# Run as non-root user for security
USER node

# Start the application
CMD ["node", "build/index.js"]
