FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY . .

EXPOSE 5050

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const https=require('https'); const r=https.get('https://localhost:5050',{rejectUnauthorized:false},(res)=>process.exit(res.statusCode===200?0:1)); r.on('error',()=>process.exit(1));"

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs
USER nodejs

CMD ["node", "serve.js"]
