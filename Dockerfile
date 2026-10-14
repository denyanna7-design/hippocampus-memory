FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV PORT=3000 MEMORY_DIR=/data/memory
VOLUME ["/data"]
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
