# Multi-stage build для React додатку
FROM node:18-alpine as build

# Встановлюємо робочу директорію
WORKDIR /app

# Копіюємо package.json та package-lock.json
COPY package*.json ./

# Встановлюємо залежності (включаючи dev для збірки)
RUN npm ci

# Копіюємо вихідний код
COPY . .

# Збираємо додаток
RUN npm run build

# Production stage
FROM nginx:alpine

# Копіюємо зібраний додаток в nginx
COPY --from=build /app/dist /usr/share/nginx/html

# Вбудована конфігурація nginx для SPA (без окремого файлу)
RUN printf "server {\n    listen 80;\n    server_name localhost;\n    root /usr/share/nginx/html;\n    index index.html;\n\n    location / {\n        try_files \$uri \$uri/ /index.html;\n    }\n\n    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg)$ {\n        expires 1y;\n        add_header Cache-Control 'public, immutable';\n    }\n\n    gzip on;\n    gzip_vary on;\n    gzip_min_length 1024;\n    gzip_types text/plain text/css text/xml text/javascript application/javascript application/xml+rss application/json;\n}\n" > /etc/nginx/conf.d/default.conf

# Відкриваємо порт 80
EXPOSE 80

# Запускаємо nginx
CMD ["nginx", "-g", "daemon off;"]
