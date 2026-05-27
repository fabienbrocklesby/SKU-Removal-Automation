FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY scripts ./scripts
COPY tests ./tests
COPY README.md ./

RUN npm test

VOLUME ["/app/catalog-runs"]

ENTRYPOINT ["node"]
CMD ["scripts/catalog-cleanup.mjs", "--help"]
