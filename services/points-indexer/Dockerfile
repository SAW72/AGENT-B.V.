FROM node:22.20.0-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config ./config

ENV NODE_ENV=production
ENV CHAIN_ID=84532

USER node
CMD ["npm", "start"]
