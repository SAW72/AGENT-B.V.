# Build from the repository root. The notice file has one source in git,
# config/reputation/sepolia.json, and this image copies that file in.
#   docker build -f services/points-indexer/Dockerfile .
FROM node:22.20.0-bookworm-slim

WORKDIR /app

COPY services/points-indexer/package.json services/points-indexer/package-lock.json ./
RUN npm ci --omit=dev

COPY services/points-indexer/src ./src
COPY services/points-indexer/config ./config
COPY config/reputation/sepolia.json ./config/reputation/sepolia.json

ENV NODE_ENV=production
ENV CHAIN_ID=84532

USER node
CMD ["npm", "start"]
