FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY apps/backend/package.json ./apps/backend/package.json
RUN npm install --workspace apps/backend --include-workspace-root
COPY apps/backend ./apps/backend
WORKDIR /app/apps/backend
EXPOSE 8080
CMD ["npm", "run", "start"]
