FROM node:20-alpine

# Build tools + OCR + PDF tools
RUN apk add --no-cache python3 make g++ \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-data-deu \
    && apk add --no-cache tesseract-ocr-data-eng || true

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
