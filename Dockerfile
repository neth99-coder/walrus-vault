FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_ENOKI_API_KEY
ARG VITE_GOOGLE_CLIENT_ID

ENV VITE_ENOKI_API_KEY=$VITE_ENOKI_API_KEY
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
