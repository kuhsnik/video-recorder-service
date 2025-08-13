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

# Create necessary directories
RUN mkdir -p /tmp

# Set up PulseAudio for audio capture
RUN echo "load-module module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse-socket" > /etc/pulse/system.pa

# Create a non-root user for Chrome
RUN groupadd -r chrome && useradd -r -g chrome -G audio chrome \
    && mkdir -p /home/chrome/Downloads /app \
    && chown -R chrome:chrome /home/chrome \
    && chown -R chrome:chrome /usr/src/app

# Set environment variables
ENV DISPLAY=:99
ENV PULSE_RUNTIME_PATH=/tmp
ENV NODE_ENV=production

# Expose port
EXPOSE 3000

# Switch to chrome user
USER chrome

# Start the application
CMD ["node", "server.js"]