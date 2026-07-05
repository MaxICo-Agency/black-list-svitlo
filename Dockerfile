FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV RUNTIME_DIR=/app/runtime

COPY . .

RUN mkdir -p /app/runtime

EXPOSE 3000

CMD ["node", "server.js"]
