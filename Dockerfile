FROM node:22.13-slim
WORKDIR /app
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY fixtures ./fixtures
COPY tsconfig.json ./
EXPOSE 3000
CMD ["npm", "start"]
