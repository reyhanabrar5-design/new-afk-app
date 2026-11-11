# Use official Node.js runtime environment
FROM node:20-slim

# Install system dependencies required for canvas & native packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy application files
COPY . .

# Expose default port
EXPOSE 10000

# Start server
CMD ["node", "server.js"]
