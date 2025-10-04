# FPV Batteries Inventory System

A comprehensive inventory management system for FPV drone batteries built with FastAPI (Python) backend and React frontend, using MongoDB Atlas for data storage.

## 🚀 Features

- **Balance Management**: Track deposits, withdrawals, and financial transactions
- **Parts Management**: Organize parts by classes and types with detailed specifications
- **Purchase Tracking**: Record purchases with vendor information and delivery status
- **Inventory Control**: Real-time inventory tracking with moving average cost calculation
- **Product Assembly**: Define products with Bill of Materials (BOM) and track assembly
- **Sales Management**: Record sales with customer information and pricing
- **Stock Management**: Track both raw materials and finished products

## 🏗️ Architecture

- **Backend**: FastAPI (Python) with MongoDB Atlas
- **Frontend**: React + Vite + Tailwind CSS
- **Database**: MongoDB Atlas (cloud)
- **Deployment**: Docker containers

## 🚀 Quick Start

### Prerequisites

- Docker and Docker Compose
- MongoDB Atlas account

### Setup

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd DroneBatteries
   ```

2. **Configure environment:**
   ```bash
   cp env.example .env
   ```
   
   Edit `.env` file with your MongoDB Atlas URI:
   ```env
   MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/
   DB_NAME=fpv_inventory
   FRONTEND_ORIGIN=http://localhost:3000
   VITE_API_BASE=http://localhost:8000
   ```

3. **Start the application:**
   ```bash
   docker compose up --build
   ```

4. **Access the application:**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:8000
   - API Documentation: http://localhost:8000/docs

## 📁 Project Structure

```
DroneBatteries/
├── fpv-inventory-backend/          # FastAPI backend
│   ├── main.py                    # Main application file
│   ├── requirements.txt           # Python dependencies
│   ├── Dockerfile                # Backend container
│   └── .dockerignore             # Docker ignore file
├── fpv-inventory-react-server/    # React frontend
│   ├── src/                      # React source code
│   ├── package.json              # Node.js dependencies
│   ├── Dockerfile                # Frontend container
│   └── .dockerignore             # Docker ignore file
├── docker-compose.yml            # Docker orchestration
├── env.example                   # Environment variables template
└── README.md                     # This file
```

## 🐳 Docker Commands

### Basic Commands

```bash
# Start (hot reload enabled via bind mounts)
docker compose up -d

# Stop all services
docker compose down

# View logs
docker compose logs -f

# Rebuild and start
docker compose up --build -d

# Start specific service
docker compose up -d backend
```

### Development Mode (simple hot reload)

```bash
# Start with hot reload (bind mounts)
docker compose up -d

# View live logs
docker compose logs -f backend frontend
```

Цей режим вже налаштований:
- **Backend**: `uvicorn --reload`, монтуємо `fpv-inventory-backend` в контейнер
- **Frontend**: Vite dev server (`npm run dev`), монтуємо `fpv-inventory-react-server` в контейнер
- **Порти**: Frontend `http://localhost:3000`, Backend `http://localhost:8000`

### Development

```bash
# View backend logs
docker compose logs backend

# View frontend logs
docker compose logs frontend

# Restart a service
docker compose restart backend
```

## 📊 API Endpoints

The backend provides the following main endpoints:

- `GET /state` - Get complete application state
- `POST /balance/entries` - Add balance entry
- `GET /balance/value` - Get current balance
- `POST /parts/classes` - Add part class
- `POST /parts/types` - Add part type
- `POST /purchases` - Create purchase
- `POST /purchases/{id}/mark-delivered` - Mark purchase as delivered
- `POST /purchases/{id}/pay-from-balance` - Pay purchase from balance
- `POST /products` - Create product
- `POST /assembly` - Assemble product
- `POST /sales` - Create sale

## 📝 Usage

1. **Setup Parts**: Start by adding part classes and types
2. **Manage Balance**: Add initial balance entries
3. **Record Purchases**: Create purchase orders and mark them as delivered
4. **Define Products**: Create products with their Bill of Materials
5. **Assemble Products**: Use available parts to assemble finished products
6. **Track Sales**: Record sales and manage customer information

## 🐛 Troubleshooting

### Common Issues

1. **"Failed to fetch" Error**: 
   - Check if backend is running: `docker compose logs backend`
   - Verify API connection: http://localhost:8000/state

2. **Empty Data**: 
   - Ensure MongoDB Atlas URI is correct in `.env` file
   - Check database connection in backend logs

3. **Port Conflicts**: 
   - Make sure ports 8000 and 3000 are available
   - Check if other services are using these ports

### Logs

```bash
# View all logs
docker compose logs -f

# View specific service logs
docker compose logs backend
docker compose logs frontend
```

## 🔧 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MONGODB_URI` | MongoDB Atlas connection string | `mongodb+srv://root:4556@cluster0.a1fqoim.mongodb.net/` |
| `DB_NAME` | Database name | `fpv_inventory` |
| `FRONTEND_ORIGIN` | Frontend URL for CORS | `http://localhost:3000` |
| `VITE_API_BASE` | Backend API URL | `http://localhost:8000` |

## 📄 License

This project is for internal use. All rights reserved.