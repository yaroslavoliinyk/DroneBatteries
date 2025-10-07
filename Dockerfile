# Multi-stage: build frontend, run FastAPI backend and serve static

# ---------- Frontend build ----------
FROM node:18-alpine AS fe-build
WORKDIR /fe
COPY fpv-inventory-react-server/package*.json ./
RUN npm ci
COPY fpv-inventory-react-server/ .
# Frontend and backend on same origin → empty VITE_API_BASE
ENV VITE_API_BASE=
RUN npm run build

# ---------- Backend runtime ----------
FROM python:3.11-slim AS runtime
WORKDIR /app

# Install backend deps
COPY fpv-inventory-backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy backend code
COPY fpv-inventory-backend/ /app/

# Copy built frontend to /app/static
RUN mkdir -p /app/static
COPY --from=fe-build /fe/dist/ /app/static/

ENV HOST=0.0.0.0
ENV PORT=8000
EXPOSE 8000

CMD uvicorn main:app --host ${HOST} --port ${PORT}


