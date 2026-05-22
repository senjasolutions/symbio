FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV SYMBIO_DATA_DIR=/data

COPY app/ ./app/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app/server.js"]
