# Use the official Puppeteer Docker image — it comes with Chromium and all
# system dependencies pre-installed, which is exactly what Render needs.
FROM ghcr.io/puppeteer/puppeteer:22.15.0

# Set working directory
WORKDIR /app

# Switch to root to copy files (puppeteer image uses pptruser by default)
USER root

# Copy package files and install dependencies
# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true because the image already has Chromium
COPY package.json ./
RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install --omit=dev

# Copy the rest of the application
COPY . .

# Switch back to the non-root user for security
USER pptruser

# Expose the port Render will use
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
