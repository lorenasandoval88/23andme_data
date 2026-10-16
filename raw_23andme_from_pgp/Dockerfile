FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy only the executable; never copy credentials or generated participant data.
COPY --chown=node:node index.js ./
USER node

CMD ["node", "--expose-gc", "--max-old-space-size=28672", "index.js"]
