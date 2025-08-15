FROM node:18-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    xvfb \
    ffmpeg \
    pulseaudio \
    alsa-utils \
    && rm -rf /var/lib/apt/lists/*

# Add Google Chrome repository and install Chrome
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --only=production

# Copy application code
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p /usr/src/app/recordings /usr/src/app/chrome-data \
    && chmod 755 /usr/src/app/recordings /usr/src/app/chrome-data

# Set up PulseAudio for audio capture
RUN echo "load-module module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse-socket" > /etc/pulse/system.pa

# Create directories for Chrome
RUN mkdir -p /tmp/chrome-data

# Set environment variables
ENV DISPLAY=:99
ENV PULSE_RUNTIME_PATH=/tmp
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Run as root (default for Render containers)

# Start the application
CMD ["node", "server.js"]