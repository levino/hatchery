FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/
CMD ["node", "--experimental-strip-types", "src/creds-service.ts"]
