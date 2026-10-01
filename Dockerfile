FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY . .

EXPOSE 5050

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http=require('http'); const r=http.get('http://localhost:5050',(res)=>process.exit(res.statusCode===200?0:1)); r.on('error',()=>process.exit(1));"

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs
USER nodejs

# --env-file-if-exists matches package.json "start": a developer-supplied .env is
# picked up when it exists and silently ignored when it does not, so the image
# still starts with no .env at all. A real environment variable still wins over
# the file. Requires Node >= 20.12; node:20-alpine satisfies that.
CMD ["node", "--env-file-if-exists=.env", "serve.js"]
